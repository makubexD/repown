// What origin says to a dry-run push, as the clone's pinned account (ADR-031).
//
// A read is no check: github.com answers `ls-remote` of a public repository without asking for
// the credential at all, so a revoked token reads as fine (measured). The push endpoint always
// asks. `git push --dry-run` stops after the ref advertisement and sends nothing.
//
// The WHOLE stderr is read: the SSO refusal's fix is the `visit <url>` line git prints before
// its last one.

import { succeeded, type ExecResult } from './exec.ts';
import { networkReason } from './git.ts';
import { copyableCommand } from './shell.ts';

export type SignInVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'sso'; readonly link: string | null }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'denied'; readonly as: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-sign-in' }
  | { readonly kind: 'unchecked'; readonly reason: string };

/** First match wins: SSO's 403 also reads as "unable to access", so it goes first. */
const PATTERNS: readonly [RegExp, (stderr: string) => SignInVerdict][] = [
  [/SAML SSO/, (stderr) => ({ kind: 'sso', link: /visit (https:\/\/\S+)/.exec(stderr)?.[1] ?? null })],
  [/Permission to \S+ denied to /, (stderr) => ({ kind: 'denied', as: /denied to ([^\s.]+)/.exec(stderr)?.[1] ?? '' })],
  [/Invalid username or token|Authentication failed/, () => ({ kind: 'rejected' })],
  [/Repository not found/, () => ({ kind: 'not-found' })],
  [/unable to get password|Cannot prompt because user interactivity has been disabled|could not read Username|terminal prompts disabled/, () => ({ kind: 'no-sign-in' })],
];

export function classifySignIn(result: ExecResult): SignInVerdict {
  if (succeeded(result)) return { kind: 'ok' };
  if (result.timedOut) return { kind: 'unchecked', reason: 'timed out' };
  const found = PATTERNS.find(([pattern]) => pattern.test(result.stderr));
  return found ? found[1](result.stderr) : { kind: 'unchecked', reason: networkReason(result) };
}

export interface SignInContext {
  /**
   * The username git sends for origin (the pinned credential username), or null when nothing
   * names one: an SSH or local origin, a host repown doesn't pin (ADR-009), or no pin yet.
   */
  readonly account: string | null;
  /** The clone's recorded account, for `repown use`; null outside a set-up clone. */
  readonly pinned: string | null;
  /** Git Credential Manager serves origin's URL. */
  readonly gcm: boolean;
  /** origin is on github.com, where GCM's `github login` was measured (ADR-009). */
  readonly github: boolean;
}

export interface SignInReport {
  readonly level: 'pass' | 'fail' | 'warn';
  readonly message: string;
  /** Lines of advice, each a label and what to run; empty when nothing is claimed. */
  readonly fix: readonly string[];
}

export function describeSignIn(verdict: SignInVerdict, ctx: SignInContext): SignInReport {
  const whose = ctx.account ? ctx.account + '\'s sign-in' : 'this clone\'s sign-in';
  switch (verdict.kind) {
    case 'ok': return { level: 'pass', message: (ctx.account ? 'origin accepts ' + whose + ' for a push' : 'origin accepts a push from this clone') + ' (a dry run: nothing was sent)', fix: [] };
    case 'sso': return { level: 'fail', message: 'origin refused ' + whose + ': the organisation enforces SAML SSO, and this sign-in isn\'t authorised for it.', fix: ssoFix(verdict.link) };
    case 'rejected': return { level: 'fail', message: 'the host rejected ' + whose + ': the token or password git holds was expired, revoked or wrong.', fix: loginFix(ctx) };
    case 'denied': return denied(verdict.as, ctx);
    case 'not-found': return { level: 'fail', message: 'origin was not found with ' + whose + ': that account can\'t see it (the wrong account, or no access).', fix: ['check the account (repown status), or ask for access'] };
    case 'no-sign-in': return { level: 'fail', message: 'no sign-in is stored' + (ctx.account ? ' for ' + ctx.account : '') + ', so a push would ask for one.', fix: loginFix(ctx) };
    case 'unchecked': return { level: 'warn', message: 'couldn\'t check the sign-in: ' + verdict.reason, fix: [] };
  }
}

function ssoFix(link: string | null): string[] {
  const then = 'then:          repown doctor --online';
  return link ? ['authorise it:  ' + link, then] : ['authorise this sign-in in the organisation\'s SSO settings', then];
}

/** GCM's own sign-in, only where it was measured, and only when the account quotes safely. */
function loginFix(ctx: SignInContext): string[] {
  if (!ctx.gcm || !ctx.github || !ctx.account) return [];
  const command = copyableCommand(['git', 'credential-manager', 'github', 'login', '--username', ctx.account, '--browser', '--force']);
  return command ? ['sign in again:  ' + command] : [];
}

/** Signed in as someone who can't push: the pinned account when it differs, else write access. */
function denied(as: string, ctx: SignInContext): SignInReport {
  const pinned = ctx.pinned;
  if (!pinned || !as || as.toLowerCase() === pinned.toLowerCase()) {
    return { level: 'fail', message: 'origin refused the push: ' + (as || 'this sign-in') + ' can\'t push here; ask for write access.', fix: [] };
  }
  const command = copyableCommand(['repown', 'use', pinned]);
  return { level: 'fail', message: 'origin refused the push: git signed in as ' + as + ', not ' + pinned + ', and ' + as + ' can\'t push here.', fix: command ? ['use the pinned account:  ' + command] : [] };
}
