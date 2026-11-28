// What the push remote says to a dry-run push, as the clone's pinned account (ADR-031).
//
// A read is no check: github.com answers `ls-remote` of a public repository without asking for
// the credential at all, so a revoked token reads as fine (measured). The push endpoint always
// asks. `git push --dry-run` stops after the ref advertisement and sends nothing.
//
// The WHOLE stderr is read: the SSO refusal's fix is the `visit <url>` line git prints before
// its last one, and an SSH refusal's cause is its first line (ADR-032).

import { succeeded, type ExecResult } from './exec.ts';
import { networkReason } from './git.ts';
import { copyableCommand } from './shell.ts';
import { isGcm } from './credential/gcm.ts';
import { isGh } from './credential/gh.ts';

export type SignInVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'sso'; readonly link: string | null }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'denied'; readonly as: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-sign-in' }
  | { readonly kind: 'ssh-key' }
  | { readonly kind: 'deploy-key' }
  | { readonly kind: 'host-key' }
  | { readonly kind: 'unchecked'; readonly reason: string };

/** First match wins: SSO's 403 also reads as "unable to access", so it goes first. */
const PATTERNS: readonly [RegExp, (stderr: string) => SignInVerdict][] = [
  [/SAML SSO/, (stderr) => ({ kind: 'sso', link: /visit (https:\/\/\S+)/.exec(stderr)?.[1] ?? null })],
  [/Permission to \S+ denied to deploy key/, () => ({ kind: 'deploy-key' })],
  [/Permission to \S+ denied to /, (stderr) => ({ kind: 'denied', as: /denied to ([^\s.]+)/.exec(stderr)?.[1] ?? '' })],
  [/Invalid username or token|Authentication failed/, () => ({ kind: 'rejected' })],
  [/Repository not found/, () => ({ kind: 'not-found' })],
  [/unable to get password|Cannot prompt because user interactivity has been disabled|could not read Username|terminal prompts disabled/, () => ({ kind: 'no-sign-in' })],
  [/Host key verification failed/, () => ({ kind: 'host-key' })],
  [/Permission denied \(publickey/, () => ({ kind: 'ssh-key' })],
];

/** A porcelain `!` line: the remote refused the ref itself, so the sign-in had already passed. */
const REF_REJECTED = /^!\t/m;

export function classifySignIn(result: ExecResult): SignInVerdict {
  if (succeeded(result)) return { kind: 'ok' };
  if (result.timedOut) return { kind: 'unchecked', reason: 'timed out' };
  const found = PATTERNS.find(([pattern]) => pattern.test(result.stderr));
  if (found) return found[1](result.stderr);
  return REF_REJECTED.test(result.stdout) ? { kind: 'ok' } : { kind: 'unchecked', reason: networkReason(result) };
}

export interface SignInContext {
  /** The remote asked: the one a plain `git push` uses. */
  readonly remote: string;
  /** The push URL's host, for the ssh advice; null for a local path. */
  readonly host: string | null;
  /**
   * The username git sends to the push URL (the URL's own user, else the pinned credential
   * username), or null when nothing names one: SSH, a local path, or a host repown doesn't pin.
   */
  readonly account: string | null;
  /** `account` is the push URL's own username, which `repown use` can't change. */
  readonly fromUrl: boolean;
  /** The clone's recorded account, for `repown use`; null outside a set-up clone. */
  readonly pinned: string | null;
  /** The credential helper that serves the push URL; null when none does (or it isn't HTTPS). */
  readonly helper: string | null;
  /** The push URL is on github.com, where GCM's `github login` was measured (ADR-009). */
  readonly github: boolean;
}

export interface SignInReport {
  readonly level: 'pass' | 'fail' | 'warn';
  readonly message: string;
  /** Lines of advice, each a label and what to run; never empty on a FAIL. */
  readonly fix: readonly string[];
}

export function describeSignIn(verdict: SignInVerdict, ctx: SignInContext): SignInReport {
  const whose = ctx.account ? ctx.account + '\'s sign-in' : 'this clone\'s sign-in';
  const fail = (message: string, fix: readonly string[]): SignInReport => ({ level: 'fail', message: ctx.remote + message, fix });
  switch (verdict.kind) {
    case 'ok': return { level: 'pass', message: ctx.remote + (ctx.account ? ' accepts ' + whose + ' for a push' : ' accepts a push from this clone') + ' (a dry run: nothing was sent)', fix: [] };
    case 'sso': return fail(' refused ' + whose + ': the organisation enforces SAML SSO, and this sign-in isn\'t authorised for it.', ssoFix(verdict.link));
    case 'rejected': return fail(' rejected ' + whose + ': the token or password git held was expired, revoked or wrong, and git has asked the helper to forget it.', signInFix(ctx));
    case 'denied': return denied(verdict.as, ctx);
    case 'not-found': return fail(' was not found with ' + whose + ': that account can\'t see it (the wrong account, or no access).', ['check the account (repown status), or ask for access']);
    case 'no-sign-in': return fail(': no sign-in is stored' + (ctx.account ? ' for ' + ctx.account : '') + ', so a push would ask for one.', signInFix(ctx));
    case 'deploy-key': return fail(' refused the push: the SSH key is a deploy key without write access here.', ['give that deploy key write access, or sign in with an account\'s own key']);
    case 'ssh-key': return fail(' refused this machine\'s SSH key: it isn\'t added to an account that can push here.', sshFix('see which account the key signs in as:  ', ctx));
    case 'host-key': return fail(': ssh doesn\'t trust ' + (ctx.host ?? 'the host') + '\'s host key yet, so it stopped before signing in.', sshFix('check and trust it once:  ', ctx));
    case 'unchecked': return { level: 'warn', message: 'couldn\'t check the sign-in: ' + verdict.reason, fix: [] };
  }
}

function ssoFix(link: string | null): string[] {
  const then = 'then:          repown doctor --online';
  return link ? ['authorise it:  ' + link, then] : ['authorise this sign-in in the organisation\'s SSO settings', then];
}

/** How to sign in again, by helper; GCM's own command only where it was measured. */
function signInFix(ctx: SignInContext): string[] {
  if (isGh(ctx.helper)) return ['gh signs in as its active account; undo it:  repown fix'];
  if (!ctx.helper) return ['no credential helper serves this URL; install Git Credential Manager, then: repown doctor --online'];
  if (!isGcm(ctx.helper)) return ['sign in again through the credential helper (' + ctx.helper + '); a push in a terminal asks'];
  const command = ctx.github && ctx.account ? gcmLogin(ctx.account) : null;
  return [command ? 'sign in again:  ' + command : 'sign in again through Git Credential Manager; a push in a terminal asks'];
}

/** GCM's sign-in for github.com (measured, GCM 2.6.1); null when no shell quotes the account. */
export function gcmLogin(account: string): string | null {
  return copyableCommand(['git', 'credential-manager', 'github', 'login', '--username', account, '--browser', '--force']);
}

/** git sent the pinned username, but the helper answered with another account's token. */
function storedFor(ctx: SignInContext): string[] {
  return ['the stored sign-in for ' + ctx.account + ' is another account\'s', ...signInFix(ctx)];
}

function sshFix(label: string, ctx: SignInContext): string[] {
  const command = ctx.host ? copyableCommand(['ssh', '-T', 'git@' + ctx.host]) : null;
  return [command ? label + command : 'check this machine\'s SSH key and known_hosts for the remote'];
}

/** Signed in as someone who can't push: the pinned account when it differs, else write access. */
function denied(as: string, ctx: SignInContext): SignInReport {
  const pinned = ctx.pinned;
  if (!pinned || !as || as.toLowerCase() === pinned.toLowerCase()) {
    return { level: 'fail', message: ctx.remote + ' refused the push: ' + (as || 'this sign-in') + ' can\'t push here.', fix: ['ask the owner for write access'] };
  }
  const message = ctx.remote + ' refused the push: git signed in as ' + as + ', not ' + pinned + ', and ' + as + ' can\'t push here.';
  if (!ctx.account) return { level: 'fail', message, fix: sshFix('the SSH key signs in as ' + as + '; see which key:  ', ctx) };
  if (ctx.account.toLowerCase() === pinned.toLowerCase()) return { level: 'fail', message, fix: storedFor(ctx) };
  if (ctx.fromUrl) return { level: 'fail', message, fix: ['the push URL names ' + as + '; remove it (repown status prints the command)'] };
  const command = copyableCommand(['repown', 'use', pinned]);
  return { level: 'fail', message, fix: [command ? 'use the pinned account:  ' + command : 'pin ' + pinned + ' again with repown use'] };
}
