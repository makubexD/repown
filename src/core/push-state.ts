// The facts about this clone that decide whether its next commit, pull or push works:
// read once, offline, for setup and status to turn into blockers (src/core/blockers.ts).
//
// Every read that fails is kept as a failure (a Result), never as "nothing found", so
// a clone that could not be read is never reported ready. The push target is resolved
// the way a plain `git push` resolves it (push-destination.ts), and a secret in a URL is
// only ever reported by the config key that holds it.

import type { Git } from './git.ts';
import { ok, type Result } from './result.ts';
import { hasTrackingRefs, pushTarget, unknownDestination, type PushTarget } from './push-destination.ts';
import { parseGitUrl } from './url.ts';
import { providerFor } from './hosts/index.ts';
import { hostileSet } from './guard/check.ts';
import type { UnpushedCommit, UnpushedFact } from './unpushed.ts';

/** Where a plain `git push` goes: its remote (null for a URL) and that URL's owner. */
export interface PushDestination {
  readonly remote: string | null;
  readonly owner: string;
  /** `repown.allowOwner` in this clone, lowercased. */
  readonly allowed: readonly string[];
}

/** A URL in `key` naming the same repository as `remote`: setup can point `key` back at the remote. */
export interface Repoint {
  readonly key: string;
  readonly remote: string;
  /** The remote has tracking refs, so after the repoint the destination is known without a fetch. */
  readonly tracked: boolean;
}

export interface Divergence {
  readonly tracked: string;
  readonly behind: number;
  readonly ahead: number;
}

export interface PushFacts {
  readonly unpushed: UnpushedFact;
  /** Identity or token variables set in this process's environment, by name. */
  readonly env: readonly string[];
  /** `author.email` / `committer.email` set in config: they outrank `user.email` for commits. */
  readonly configOverrides: readonly string[];
  /** Commits the destination lacks that another remote has: the guard refuses them too. */
  readonly elsewhere: Result<readonly UnpushedCommit[]>;
  /** The config key that carries its own sign-in on the push path (the value is never kept). */
  readonly signinKey: string | null;
  readonly repoint: Repoint | null;
  readonly destination: PushDestination | null;
  /** Against the tracked ref on the destination; ok(null) when there is none. */
  readonly divergence: Result<Divergence | null>;
  readonly detached: boolean;
  /** `missing`: a plain `git push` would fail for want of an upstream. Null when not applicable. */
  readonly upstream: 'set' | 'missing' | null;
}

const OVERRIDES = ['author.email', 'committer.email'];

export async function readPushFacts(git: Git, unpushed: UnpushedFact, env: NodeJS.ProcessEnv = process.env): Promise<PushFacts> {
  const head = await git.currentBranch();
  const branch = head?.kind === 'branch' ? head.name : null;
  const target = branch ? await pushTarget(git, branch) : null;
  const [configOverrides, signinKey, repoint, destination, divergence, elsewhere, upstream] = await Promise.all([
    overridesIn(git), signinOf(git, target), repointOf(git, branch), destinationOf(git, target),
    divergenceOf(git, target), elsewhereOf(git, target), upstreamOf(git, branch, target),
  ]);
  return {
    unpushed, env: hostileSet(env), configOverrides, elsewhere, signinKey, repoint, destination, divergence,
    detached: head?.kind === 'detached', upstream,
  };
}

async function overridesIn(git: Git): Promise<string[]> {
  const values = await Promise.all(OVERRIDES.map((key) => git.getConfig(key)));
  return OVERRIDES.filter((_, index) => values[index]);
}

/** A password or a token in the userinfo. A bare username (GCM's own advice) is not a secret. */
function carriesSecret(raw: string | null): boolean {
  const user = raw ? parseGitUrl(raw)?.user : null;
  return !!user && (user.includes(':') || /^(gh[pousr]_|github_pat_)/i.test(user));
}

async function signinOf(git: Git, target: PushTarget | null): Promise<string | null> {
  if (target && !target.isRemote && carriesSecret(target.name)) return target.key;
  if (target?.isRemote) {
    // A push uses pushurl when there is one, so a token in the fetch url does not sign it in.
    const key = await git.getConfig('remote.' + target.name + '.pushurl') !== null ? 'remote.' + target.name + '.pushurl' : 'remote.' + target.name + '.url';
    if (carriesSecret(await git.getConfig(key))) return key;
  }
  const headers = await git.configOrigins('^http\\.(.*\\.)?extraheader$');
  return headers[0]?.key ?? null;
}

async function repointOf(git: Git, branch: string | null): Promise<Repoint | null> {
  const unknown = branch ? await unknownDestination(git, branch) : null;
  if (unknown?.kind !== 'url' || !unknown.remote) return null;
  const tracked = await hasTrackingRefs(git, unknown.remote);
  return { key: unknown.key, remote: unknown.remote, tracked: tracked.ok && tracked.value };
}

async function destinationOf(git: Git, target: PushTarget | null): Promise<PushDestination | null> {
  if (!target) return null;
  const raw = target.isRemote ? await pushUrlOf(git, target.name) : await bareTargetUrl(git, target.name);
  const url = raw ? parseGitUrl(raw) : null;
  const owner = url ? providerFor(url).ownerOf(url) : null;
  if (!owner) return null;
  const allowed = (await git.getAllConfig('repown.allowOwner', 'local')).map((value) => value.toLowerCase());
  return { remote: target.isRemote ? target.name : null, owner, allowed };
}

function pushUrlOf(git: Git, remote: string): Promise<string | null> {
  return git.remotePushUrl(remote);
}

/** A push straight to a URL, as git rewrites it (insteadOf; see rewrittenUrl). */
async function bareTargetUrl(git: Git, url: string): Promise<string> {
  return (await git.rewrittenUrl(url)) ?? url;
}

/** Only the tracked ref ON the destination: a triangular workflow's upstream does not block its push. */
async function divergenceOf(git: Git, target: PushTarget | null): Promise<Result<Divergence | null>> {
  if (!target?.isRemote) return ok(null);
  const tracked = await git.upstreamRef();
  if (!tracked || !tracked.startsWith(target.name + '/')) return ok(null);
  const counts = await git.leftRightCount(tracked + '...HEAD');
  if (!counts.ok) return counts;
  return ok({ tracked, behind: counts.value.left, ahead: counts.value.right });
}

/** The guard excludes only the destination's refs; `--remotes` excludes every remote's. */
async function elsewhereOf(git: Git, target: PushTarget | null): Promise<Result<readonly UnpushedCommit[]>> {
  if (!target?.isRemote || !await git.hasCommit('HEAD')) return ok([]);
  const [guarded, anywhere] = await Promise.all([
    git.identitiesIn(['HEAD', '--not', '--remotes=' + target.name]),
    git.identitiesIn(['HEAD', '--not', '--remotes']),
  ]);
  if (!guarded.ok) return guarded;
  if (!anywhere.ok) return anywhere;
  const unpushed = new Set(anywhere.value.map((commit) => commit.sha));
  return ok(guarded.value.filter((commit) => !unpushed.has(commit.sha))
    .map((commit) => ({ authorEmail: commit.authorEmail, committerEmail: commit.committerEmail, parent: null })));
}

/** `missing` only where git would refuse a plain push: default push.default, no pushRemote, no autoSetupRemote. */
async function upstreamOf(git: Git, branch: string | null, target: PushTarget | null): Promise<PushFacts['upstream']> {
  if (!branch || !target?.isRemote) return null;
  if (await git.upstreamRef()) return 'set';
  if (target.key && target.key !== 'branch.' + branch + '.remote') return null;
  const [mode, auto] = await Promise.all([git.getConfig('push.default'), git.getBoolConfig('push.autoSetupRemote')]);
  if (auto === true || (mode && !['simple', 'upstream', 'tracking'].includes(mode.toLowerCase()))) return null;
  return 'missing';
}
