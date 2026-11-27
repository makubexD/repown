// `repown doctor --online`: ask origin, once, whether it accepts this clone's sign-in for a
// push (ADR-031). Opt-in, never in the push path (ADR-004): without the flag doctor stays
// offline.

import { pinsCredential, type RepoState } from '../core/inspect.ts';
import { isGcm } from '../core/credential/gcm.ts';
import { classifySignIn, describeSignIn, type SignInReport, type SignInVerdict } from '../core/signin-check.ts';
import { parseGitUrl, type GitUrl } from '../core/url.ts';
import * as out from '../ui/format.ts';

/** Prints the verdict and returns its level; nothing to ask with is a warning, never a pass. */
export async function checkOnline(repo: RepoState, pinned: string | null): Promise<SignInReport['level']> {
  out.heading('This clone, asked online');
  const blocked = await nothingToAsk(repo);
  if (blocked) { out.warn('sign-in', blocked); return 'warn'; }
  const verdict = ownLink(classifySignIn(await repo.git.signInProbe('origin')), httpsUrl(repo));
  return printed(describeSignIn(verdict, { account: sentAccount(repo), pinned, gcm: isGcm(repo.helper), github: onGithubCom(repo) }));
}

/** The username git sends: the pinned credential username, only where repown pins one over HTTPS. */
function sentAccount(repo: RepoState): string | null {
  return pinsCredential(repo) && httpsUrl(repo) ? repo.identity.account : null;
}

function httpsUrl(repo: RepoState): GitUrl | null {
  const url = repo.credentialUrl ? parseGitUrl(repo.credentialUrl) : null;
  return url?.scheme === 'https' ? url : null;
}

/** The SSO link comes from the remote: shown only when it points at origin's own host. */
function ownLink(verdict: SignInVerdict, origin: GitUrl | null): SignInVerdict {
  if (verdict.kind !== 'sso' || !verdict.link) return verdict;
  const host = URL.canParse(verdict.link) ? new URL(verdict.link).hostname.toLowerCase() : null;
  return host !== null && host === origin?.host.toLowerCase() ? verdict : { kind: 'sso', link: null };
}

/** Why there is no push to try, or null when there is one. */
async function nothingToAsk(repo: RepoState): Promise<string | null> {
  if (!repo.isRepo || repo.originUrl === null) return 'not checked: --online asks origin, and there is no clone with an origin here.';
  if (await repo.git.revParse('HEAD') === null) return 'not checked: there is no commit to try a push with yet. Commit once, then: repown doctor --online';
  return null;
}

/** GCM's `github login` was measured on github.com only (ADR-009). */
function onGithubCom(repo: RepoState): boolean {
  return httpsUrl(repo)?.host.toLowerCase() === 'github.com';
}

function printed(report: SignInReport): SignInReport['level'] {
  const message = out.printable(report.message);
  if (report.level === 'pass') out.pass('sign-in', message);
  else if (report.level === 'fail') out.fail('sign-in', message);
  else out.warn('sign-in', message);
  for (const line of report.fix) out.detail(out.printable(line));
  return report.level;
}

/** The closing line, with what the online check found added to the offline verdict. */
export function closingWithOnline(verdict: string, code: number, level: SignInReport['level']): string {
  if (level === 'fail') return code === 0 ? '1 problem: origin refused the sign-in (above)' : verdict + ' · and origin refused the sign-in';
  if (level === 'warn') return verdict + ' · sign-in not checked online';
  return verdict + ' · origin accepts the sign-in';
}
