// `repown doctor --online`: ask the remote a plain `git push` uses, once, whether it accepts
// this clone's sign-in for a push (ADR-031). Opt-in, never in the push path (ADR-004):
// without the flag doctor stays offline.
//
// Everything said about the sign-in (account, helper, host, SSO link) describes the URL the
// probe really pushes to (`remote get-url --push`, after insteadOf and pushInsteadOf), never
// the fetch URL: an HTTPS fetch with an SSH push signs in with a key, not a token.

import { inspectRepo, keysOf, type RepoState } from '../core/inspect.ts';
import { carriesSecret } from '../core/push-state.ts';
import { pushTarget } from '../core/push-destination.ts';
import { classifySignIn, describeSignIn, type SignInReport, type SignInVerdict } from '../core/signin-check.ts';
import { parseGitUrl, type GitUrl } from '../core/url.ts';
import type { Git } from '../core/git.ts';
import * as out from '../ui/format.ts';
import { gitFor, type Args } from '../ui/args.ts';
import { interactive } from '../ui/prompt.ts';
import { repairFor } from '../core/signin-repair.ts';
import { guideSignIn, type GuidedCheck } from './signin-guide.ts';
import { terminalIo } from './signin-terminal.ts';

/** The remote asked and what its push URL says about the sign-in. */
interface Target {
  readonly remote: string;
  /** The push URL, or null when the remote has none. */
  readonly raw: string | null;
  /** That URL when it is HTTPS: the only scheme a username and a helper apply to. */
  readonly https: GitUrl | null;
  /** The push URL's host, whatever its scheme; null for a local path. */
  readonly host: string | null;
  readonly account: string | null;
  readonly fromUrl: boolean;
  readonly helper: string | null;
}

/** The check's answer; on a terminal, after the guided repair (ADR-032). */
export type OnlineCheck = GuidedCheck;

/**
 * Asks once; in a terminal, offers each repair and asks again after it. Each round reads the
 * clone afresh, since a repair (fix, use) changes the config the next check depends on.
 */
export async function askOnline(args: Args, repo: RepoState, pinnedOf: (repo: RepoState) => string | null): Promise<OnlineCheck> {
  if (!interactive()) return checkOnline(repo, pinnedOf(repo));
  let round = 0;
  const check = async (): Promise<OnlineCheck> => {
    const fresh = round === 0 ? repo : await inspectRepo(gitFor(args));
    return checkOnline(fresh, pinnedOf(fresh), round++ === 0);
  };
  return guideSignIn(check, terminalIo(args));
}

/** Prints the verdict and returns it with its repair; nothing to ask with is a warning, never a pass. */
export async function checkOnline(repo: RepoState, pinned: string | null, heading = true): Promise<OnlineCheck> {
  if (heading) out.heading('This clone, asked online');
  const target = repo.isRepo ? await targetOf(repo) : null;
  const blocked = await nothingToAsk(repo, target);
  if (blocked || !target) { out.warn('sign-in', blocked ?? 'not checked'); return { level: 'warn', remote: target?.remote ?? 'origin', repair: null }; }
  out.detail('asking ' + target.remote + ' with a dry-run push…');
  const verdict = ownLink(classifySignIn(await repo.git.signInProbe(target.remote)), target.https);
  const ctx = { ...target, pinned, github: target.https?.host.toLowerCase() === 'github.com' };
  const level = printed(describeSignIn(verdict, ctx));
  return { level, remote: target.remote, repair: level === 'fail' ? repairFor(verdict, ctx) : null };
}

async function targetOf(repo: RepoState): Promise<Target> {
  const remote = await pushRemote(repo);
  const raw = await repo.git.remotePushUrl(remote);
  const parsed = raw ? parseGitUrl(raw) : null;
  const https = parsed?.scheme === 'https' ? parsed : null;
  const host = parsed?.host || null;
  if (!raw || !https) return { remote, raw, https, host, account: null, fromUrl: false, helper: null };
  const [account, helper] = await Promise.all([sentUser(repo.git, raw, https), repo.git.getUrlMatch('credential.helper', raw)]);
  return { remote, raw, https, host, account, fromUrl: !!https.user && account !== null, helper };
}

/** The remote a plain push sends HEAD's branch to; origin when that is a URL or can't be read. */
async function pushRemote(repo: RepoState): Promise<string> {
  if (repo.branch?.kind !== 'branch') return 'origin';
  const target = await pushTarget(repo.git, repo.branch.name);
  return target?.isRemote ? target.name : 'origin';
}

/** The username git sends: the URL's own (never a secret), else the pin where repown pins one. */
async function sentUser(git: Git, raw: string, url: GitUrl): Promise<string | null> {
  if (url.user) return carriesSecret(raw) ? null : url.user;
  return keysOf(raw).length > 0 ? git.getUrlMatch('credential.username', raw) : null;
}

/** The SSO link comes from the remote: shown only when it points at the push URL's own host. */
function ownLink(verdict: SignInVerdict, url: GitUrl | null): SignInVerdict {
  if (verdict.kind !== 'sso' || !verdict.link) return verdict;
  const host = URL.canParse(verdict.link) ? new URL(verdict.link).hostname.toLowerCase() : null;
  return host !== null && host === url?.host.toLowerCase() ? verdict : { kind: 'sso', link: null };
}

/** Why there is no push to try, or null when there is one. */
async function nothingToAsk(repo: RepoState, target: Target | null): Promise<string | null> {
  if (!target || target.raw === null) return 'not checked: --online asks the remote a push goes to, and there is no clone with one here.';
  if (await repo.git.revParse('HEAD') === null) return 'not checked: there is no commit to try a push with yet. Commit once, then: repown doctor --online';
  return null;
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
export function closingWithOnline(verdict: string, code: number, level: SignInReport['level'], named = 'origin'): string {
  const remote = out.printable(named);
  if (level === 'fail') return code === 0 ? '1 problem: ' + remote + ' refused the sign-in (above)' : verdict + ' · and ' + remote + ' refused the sign-in';
  if (level === 'warn') return verdict + ' · sign-in not checked online';
  return verdict + ' · ' + remote + ' accepts the sign-in';
}
