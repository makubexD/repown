// Which repair a failed sign-in check can offer to run, and what to ask first (ADR-032). Pure:
// doctor --online and setup's last step share it, and each draws the question its own way.
//
// An offer is made only where the fix is measured and local or the user's own sign-in:
// `repown fix` (a config edit), GCM's github.com login (the user signs in, repown sees
// nothing), the SSO page (the user approves it; repown only waits), `repown use` (a config
// edit). Everything else stays printed advice.

import { isGcm } from './credential/gcm.ts';
import { isGh } from './credential/gh.ts';
import type { SignInContext, SignInVerdict } from './signin-check.ts';

export type Repair =
  | { readonly kind: 'fix' }
  | { readonly kind: 'login'; readonly account: string }
  | { readonly kind: 'sso'; readonly link: string | null }
  | { readonly kind: 'use'; readonly account: string };

/** Null when there is nothing repown can run for this verdict. */
export function repairFor(verdict: SignInVerdict, ctx: SignInContext): Repair | null {
  if (verdict.kind === 'sso') return { kind: 'sso', link: verdict.link };
  if (verdict.kind === 'rejected' || verdict.kind === 'no-sign-in') return signInRepair(ctx);
  return verdict.kind === 'denied' ? deniedRepair(verdict.as, ctx) : null;
}

/**
 * Signed in as another account: `repown use` helps only where it changes the username git
 * sends (HTTPS, not the URL's own); when git already sends the pinned one, the stored token is
 * someone else's, so sign in again. Over SSH the key decides, and nothing here changes it.
 */
function deniedRepair(as: string, ctx: SignInContext): Repair | null {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  if (ctx.fromUrl || !ctx.pinned || !as || same(as, ctx.pinned) || !ctx.account) return null;
  return same(ctx.account, ctx.pinned) ? signInRepair(ctx) : { kind: 'use', account: ctx.pinned };
}

function signInRepair(ctx: SignInContext): Repair | null {
  if (isGh(ctx.helper)) return { kind: 'fix' };
  // A username in the URL is the blocker to remove, never an account to sign in as.
  return isGcm(ctx.helper) && ctx.github && ctx.account && !ctx.fromUrl ? { kind: 'login', account: ctx.account } : null;
}

/**
 * The question before running it, or null when the repair asks its own: `repown fix` shows
 * which entries it removes, in which file, before its own question (default No). The SSO
 * repair asks nothing and waits instead.
 */
export function repairQuestion(repair: Exclude<Repair, { kind: 'sso' }>): string | null {
  switch (repair.kind) {
    case 'fix': return null;
    case 'login': return 'Sign in to GitHub as ' + repair.account + ' now? (Git Credential Manager opens your browser)';
    case 'use': return 'Pin ' + repair.account + ' to this clone again now?';
  }
}

/** What the SSO wait says: the link is printed with the verdict above it. */
export const SSO_WAIT = 'Authorise the sign-in in your browser (the link above), then press Enter to check again; type q to stop.';

/** An SSO wait may repeat (the user decides when it's done); any other repair is tried once. */
export function triedOnce(repair: Repair): string | null {
  return repair.kind === 'sso' ? null : repair.kind + ':' + ('account' in repair ? repair.account : '');
}
