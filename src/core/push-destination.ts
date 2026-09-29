// Where `git push` with no arguments sends a branch, and whether this clone can
// tell what is already there (ADR-025).
//
// `HEAD --not --remotes` only knows remote-tracking refs. A destination with none
// (a remote never fetched, an empty one, or a URL, which never gets any) may
// already hold commits that range calls unpushed, so a rebase from its base would
// rewrite published history. Nothing offline tells an empty remote from an
// unfetched one, and FETCH_HEAD is no answer: a FAILED fetch writes it too, and it
// belongs to whichever remote was fetched last. So the destination is only ever
// "known" (it has tracking refs, and pushes where it fetches from) or "unknown",
// and a read that fails is unknown.

import type { Git } from './git.ts';
import { parseGitUrl } from './url.ts';

/**
 * A destination no remote-tracking ref reaches:
 * - `remote`: a configured remote with none (or they could not be read);
 * - `pushurl`: a configured remote whose pushurl is not where it fetches from;
 * - `url`: a URL, and `key` is the config key that named it;
 * - `unnamed`: a name no remote has;
 * - `unread`: `git remote` failed.
 */
export type UnknownDestination =
  | { readonly kind: 'remote' | 'pushurl' | 'unnamed'; readonly name: string }
  | { readonly kind: 'url'; readonly key: string; readonly remote: string | null }
  | { readonly kind: 'unread' };

interface Configured {
  readonly key: string;
  readonly value: string;
}

/** Null when the branch pushes nowhere, to `.` (this repository), or where tracking refs reach. */
export async function unknownDestination(git: Git, branch: string): Promise<UnknownDestination | null> {
  const listed = await git.readRemotes();
  if (!listed.ok) return { kind: 'unread' };
  const set = await configuredTarget(git, branch);
  // No "only remote" fallback: git push has none, it fails "No configured push destination".
  const name = set?.value ?? (listed.value.includes('origin') ? 'origin' : null);
  if (!name || name === '.') return null;
  if (listed.value.includes(name)) return remoteState(git, name);
  if (!set || !looksLikeUrl(name)) return { kind: 'unnamed', name };
  return { kind: 'url', key: set.key, remote: await remoteWithUrl(git, listed.value, name) };
}

/** git's own order for a push with no arguments. */
async function configuredTarget(git: Git, branch: string): Promise<Configured | null> {
  const keys = ['branch.' + branch + '.pushRemote', 'remote.pushDefault', 'branch.' + branch + '.remote'];
  for (const key of keys) {
    const value = await git.getConfig(key);
    if (value) return { key, value };
  }
  return null;
}

async function remoteState(git: Git, name: string): Promise<UnknownDestination | null> {
  if (!await isTracked(git, name)) return { kind: 'remote', name };
  return await pushesElsewhere(git, name) ? { kind: 'pushurl', name } : null;
}

async function isTracked(git: Git, remote: string): Promise<boolean> {
  const found = await git.hasTrackingRefs(remote);
  return found.ok && found.value;
}

/** Tracking refs come from the fetch URL; a different pushurl is somewhere never fetched. */
async function pushesElsewhere(git: Git, remote: string): Promise<boolean> {
  const push = await git.getConfig('remote.' + remote + '.pushurl');
  if (!push) return false;
  return urlKey(push) !== urlKey(await git.getConfig('remote.' + remote + '.url') ?? '');
}

/** A URL or a path, as git would read it where a remote name was expected. */
function looksLikeUrl(value: string): boolean {
  return parseGitUrl(value) !== null || /[\\/:]/.test(value);
}

/** The configured remote at the same host and path, credentials aside. */
async function remoteWithUrl(git: Git, remotes: readonly string[], url: string): Promise<string | null> {
  const wanted = urlKey(url);
  for (const name of remotes) {
    if (urlKey(await git.getConfig('remote.' + name + '.url') ?? '') === wanted) return name;
  }
  return null;
}

function urlKey(raw: string): string {
  const url = parseGitUrl(raw);
  return url ? url.host.toLowerCase() + '/' + url.path : raw.trim();
}
