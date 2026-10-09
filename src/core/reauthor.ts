// Re-authoring this branch's unpushed commits by another address (ADR-026).
//
// The one place repown rewrites history, so it refuses rather than guesses. It fetches the
// push destination first and rewrites only commits no remote has, from the parent of the
// topologically oldest one by another address; a merge in that range, a commit a remote has
// inside it, or a destination whose branches this clone does not track is a refusal. The
// rebase runs with no hook at all, without autosquash and without moving other branches,
// behind a backup ref that is never overwritten, and is checked afterwards: every commit
// still there, each by the pin. Nothing here pushes.

import type { Git } from './git.ts';
import { ok, err, type Result } from './result.ts';
import { hasTrackingRefs, pushTarget, unknownDestination } from './push-destination.ts';
import { AMEND_COMMAND, isOwn, otherAddresses } from './unpushed.ts';

/** What would be rewritten: `count` commits from `base` (a full hash, or `--root`) to HEAD. */
export interface ReauthorPlan {
  readonly branch: string;
  readonly remote: string;
  readonly base: string;
  readonly count: number;
  /** Other addresses among them, as they appear. */
  readonly addresses: readonly string[];
}

export interface Rewritten {
  readonly count: number;
  readonly backup: string;
}

const IDENTITY_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
const IDENTITY_CONFIG = ['author.email', 'committer.email', 'author.name', 'committer.name'];

/** Null: nothing by another address. An error is a refusal, and nothing was changed. */
export async function planReauthor(git: Git, email: string, interactive: boolean): Promise<Result<ReauthorPlan | null>> {
  const ready = await preconditions(git, interactive);
  if (!ready.ok) return ready;
  const { branch, remote } = ready.value;
  const fetched = await git.fetchQuietly(remote);
  if (!fetched.ok) return err('could not fetch ' + remote + ' (' + fetched.error + '); nothing rewritten');
  const empty = await destinationEmpty(git, remote);
  if (!empty.ok) return empty;
  return foreignRange(git, { branch, remote, email, empty: empty.value });
}

interface Ready {
  readonly branch: string;
  readonly remote: string;
}

async function preconditions(git: Git, interactive: boolean): Promise<Result<Ready>> {
  const head = await git.currentBranch();
  if (head?.kind !== 'branch') return err('HEAD is detached: switch to a branch first');
  const blocked = await firstRefusal(git, interactive);
  if (blocked) return err(blocked);
  const unknown = await unknownDestination(git, head.name);
  if (unknown && unknown.kind !== 'remote') return err('this branch does not push to a remote repown can fetch: point the branch at a remote first');
  const target = await pushTarget(git, head.name);
  if (!target?.isRemote) return err('this branch has no remote to push to');
  return ok({ branch: head.name, remote: target.name });
}

/** Each check that would make the rewrite unsafe, or not use the pinned identity. */
async function firstRefusal(git: Git, interactive: boolean): Promise<string | null> {
  if (!await git.getConfig('repown.account', 'local')) return 'this clone is not pinned: repown use <account> first';
  const env = IDENTITY_ENV.find((name) => process.env[name]);
  if (env) return env + ' is set: the rewrite would not use the pinned address (unset it)';
  for (const key of IDENTITY_CONFIG) if (await git.getConfig(key)) return key + ' is set: the rewrite would not use the pinned address';
  const busy = await git.operationInProgress();
  if (busy) return 'a ' + busy + ' is in progress: finish or abort it first';
  const dirty = await git.hasTrackedChanges();
  if (!dirty.ok || dirty.value) return 'this clone has uncommitted changes (or files hidden with skip-worktree): commit or stash them first';
  if (!interactive && await git.getBoolConfig('commit.gpgsign') === true) return 'commit.gpgsign is on and there is no terminal to sign in: run repown reauthor in a terminal';
  return null;
}

/** True only when a successful fetch left no tracking refs AND the remote lists no branches. */
async function destinationEmpty(git: Git, remote: string): Promise<Result<boolean>> {
  const tracked = await hasTrackingRefs(git, remote);
  if (!tracked.ok) return tracked;
  if (tracked.value) return ok(false);
  const heads = await git.remoteHeadCount(remote);
  if (!heads.ok) return err('could not list ' + remote + '\'s branches (' + heads.error + '); nothing rewritten');
  if (heads.value > 0) return err('this clone does not track ' + remote + '\'s branches, so it can\'t tell what ' + remote + ' already has');
  return ok(true);
}

interface Scope {
  readonly branch: string;
  readonly remote: string;
  readonly email: string;
  readonly empty: boolean;
}

async function foreignRange(git: Git, scope: Scope): Promise<Result<ReauthorPlan | null>> {
  const listed = await git.identitiesIn(['--topo-order', 'HEAD', '--not', '--remotes']);
  if (!listed.ok) return listed;
  const foreign = listed.value.filter((commit) => !isOwn(commit, scope.email));
  const oldest = foreign.at(-1);
  if (!oldest) return ok(null);
  const parent = await git.parentOf(oldest.sha);
  if (!parent && !scope.empty) return err('the oldest of these commits is a root, and ' + scope.remote + ' is not empty');
  const base = parent ?? '--root';
  const checked = await checkRange(git, base);
  if (!checked.ok) return checked;
  return ok({ branch: scope.branch, remote: scope.remote, base, count: checked.value, addresses: otherAddresses(foreign, scope.email) });
}

/** The range must be linear and unpublished: a rebase flattens merges and rewrites all it covers. */
async function checkRange(git: Git, base: string): Promise<Result<number>> {
  const range = base === '--root' ? ['HEAD'] : [base + '..HEAD'];
  const [all, merges, unpushed] = await Promise.all([
    git.countIn(range), git.countIn(['--merges', ...range]), git.countIn([...range, '--not', '--remotes']),
  ]);
  if (!all.ok) return all;
  if (!merges.ok) return merges;
  if (!unpushed.ok) return unpushed;
  if (merges.value > 0) return err('the commits to rewrite include a merge, which a rebase would flatten: re-author them by hand');
  if (unpushed.value !== all.value) return err('a remote already has some commits in that range; nothing rewritten');
  return ok(all.value);
}

/** Backup, rebase, check. On any failure HEAD is put back where it was, or the backup is named. */
export async function applyReauthor(git: Git, plan: ReauthorPlan, email: string): Promise<Result<Rewritten>> {
  const head = await git.revParse('HEAD');
  const backup = 'refs/repown/backup/' + plan.branch + '/' + Math.floor(Date.now() / 1000);
  if (!head || !await git.createRef(backup, head)) return err('could not write a new backup ref (one from this second exists?); nothing rewritten');
  const rebased = await git.rebaseExec(plan.base, AMEND_COMMAND);
  if (!rebased.ok) return err(await restored(git, { head, branch: plan.branch, backup }, rebased.error));
  return checked(git, plan, email, backup);
}

/** Every planned commit is still there, and each is by the pin; otherwise the backup is named. */
async function checked(git: Git, plan: ReauthorPlan, email: string, backup: string): Promise<Result<Rewritten>> {
  const range = plan.base === '--root' ? ['HEAD'] : [plan.base + '..HEAD'];
  const after = await git.identitiesIn(range);
  if (!after.ok) return err('the rewritten commits could not be read (' + after.error + '); the original is at ' + backup);
  if (after.value.length !== plan.count) {
    return err(plan.count + ' commits were planned but ' + after.value.length + ' came out; the original is at ' + backup);
  }
  if (after.value.some((commit) => !isOwn(commit, email))) return err('the rewritten commits do not all carry ' + email + '; the original is at ' + backup);
  return ok({ count: after.value.length, backup });
}

interface Before {
  readonly head: string;
  readonly branch: string;
  readonly backup: string;
}

/** "Nothing rewritten" only when the abort worked and the branch is back on its old commit. */
async function restored(git: Git, before: Before, why: string): Promise<string> {
  const aborted = await git.abortRebase() || await git.operationInProgress() === null;
  const [now, branch] = await Promise.all([git.revParse('HEAD'), git.currentBranch()]);
  const back = aborted && now === before.head && branch?.kind === 'branch' && branch.name === before.branch;
  return back
    ? 'the rebase failed (' + why + '); nothing rewritten'
    : 'the rebase failed (' + why + ') and the branch did not return; finish with git rebase --abort, and the original is at ' + before.backup;
}
