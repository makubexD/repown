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
// and a read that fails is unknown. A remote that fetches only some branches (a
// --single-branch clone, a negative refspec) is unknown for a branch it leaves out:
// pushing that branch updates no tracking ref (refspec.ts).

import type { Git } from './git.ts';
import { parseGitUrl } from './url.ts';
import { ok, type Result } from './result.ts';
import { trackingPrefixes, trackingRefOf } from './refspec.ts';
import { readerOf } from './config-snapshot.ts';

/**
 * A destination no remote-tracking ref reaches:
 * - `remote`: a configured remote with none (or they could not be read);
 * - `pushurl`: a configured remote whose pushurl is not where it fetches from;
 * - `untracked`: a configured remote whose fetch refspecs leave out `branch`, the branch pushed to;
 * - `url`: a URL, and `key` is the config key that named it;
 * - `unnamed`: a name no remote has;
 * - `unread`: `git remote` failed.
 */
export type UnknownDestination =
  | { readonly kind: 'remote' | 'pushurl' | 'unnamed'; readonly name: string }
  | { readonly kind: 'untracked'; readonly name: string; readonly branch: string }
  | { readonly kind: 'url'; readonly key: string; readonly remote: string | null }
  | { readonly kind: 'unread' };

interface Configured {
  readonly key: string;
  readonly value: string;
}

/** Null when the branch pushes nowhere, to `.` (this repository), or where tracking refs reach. */
export async function unknownDestination(given: Git, branch: string): Promise<UnknownDestination | null> {
  // Read-only: one config list answers every key read below (ADR-029).
  const git = readerOf(given);
  const listed = await git.readRemotes();
  if (!listed.ok) return { kind: 'unread' };
  const set = await configuredTarget(git, branch);
  // No "only remote" fallback: git push has none, it fails "No configured push destination".
  const name = set?.value ?? (listed.value.includes('origin') ? 'origin' : null);
  if (!name || name === '.') return null;
  if (listed.value.includes(name)) return remoteState(git, { name, branch, remotes: listed.value });
  if (!set || !looksLikeUrl(name)) return { kind: 'unnamed', name };
  return { kind: 'url', key: set.key, remote: await remoteWithUrl(git, listed.value, name) };
}

/** Where a plain `git push` sends the branch: a configured remote, or a URL and the key naming it. */
export interface PushTarget {
  /** The remote's name, or the URL (or unknown name) the config gave. */
  readonly name: string;
  readonly isRemote: boolean;
  /** The config key that named it; null for the `origin` default. */
  readonly key: string | null;
}

/** Null when there is no destination, it is `.`, or the remotes could not be listed. */
export async function pushTarget(given: Git, branch: string): Promise<PushTarget | null> {
  const git = readerOf(given);
  const listed = await git.readRemotes();
  if (!listed.ok) return null;
  const set = await configuredTarget(git, branch);
  const name = set?.value ?? (listed.value.includes('origin') ? 'origin' : null);
  if (!name || name === '.') return null;
  return { name, isRemote: listed.value.includes(name), key: set?.key ?? null };
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

interface Named {
  readonly name: string;
  readonly branch: string;
  readonly remotes: readonly string[];
}

async function remoteState(git: Git, remote: Named): Promise<UnknownDestination | null> {
  const { name } = remote;
  const tracked = await trackingRefsOf(git, name, remote.remotes);
  if (!tracked.ok || !tracked.value) return { kind: 'remote', name };
  if (await pushesElsewhere(git, name)) return { kind: 'pushurl', name };
  const branch = await destinationBranch(git, remote);
  const specs = await git.getAllConfig('remote.' + name + '.fetch');
  return trackingRefOf(specs, 'refs/heads/' + branch) ? null : { kind: 'untracked', name, branch };
}

/** Whether the remote has any tracking ref where its own refspecs write them. */
export async function hasTrackingRefs(given: Git, remote: string): Promise<Result<boolean>> {
  const git = readerOf(given);
  const listed = await git.readRemotes();
  if (!listed.ok) return listed;
  return trackingRefsOf(git, remote, listed.value);
}

/** Another remote's namespace nested inside this one's (`origin/x` in `origin`'s) is not this one's. */
async function trackingRefsOf(git: Git, remote: string, remotes: readonly string[]): Promise<Result<boolean>> {
  const prefixes = trackingPrefixes(await git.getAllConfig('remote.' + remote + '.fetch'));
  if (prefixes.length === 0) return ok(false);
  const others = await Promise.all(remotes.filter((other) => other !== remote).map((other) => git.getAllConfig('remote.' + other + '.fetch')));
  const nested = others.flatMap(trackingPrefixes).filter((other) => prefixes.some((own) => other.length > own.length && other.startsWith(own)));
  return git.hasRefsUnder(prefixes, nested);
}

/** The branch a plain push updates: the upstream's under push.default=upstream, else its own name. */
async function destinationBranch(git: Git, remote: Named): Promise<string> {
  if (await git.getConfig('push.default') !== 'upstream') return remote.branch;
  if (await git.getConfig('branch.' + remote.branch + '.remote') !== remote.name) return remote.branch;
  const merge = await git.getConfig('branch.' + remote.branch + '.merge');
  return merge ? merge.replace(/^refs\/heads\//, '') : remote.branch;
}

/**
 * Tracking refs come from the first fetch URL; any push URL elsewhere (a pushurl, a second
 * url, a pushInsteadOf rewrite) is somewhere never fetched. A failed read is elsewhere.
 */
async function pushesElsewhere(git: Git, remote: string): Promise<boolean> {
  const [push, fetch] = await Promise.all([git.remoteUrls(remote, true), git.remoteUrls(remote, false)]);
  if (!push.ok || !fetch.ok) return true;
  const fetched = urlKey(fetch.value[0] ?? '');
  return push.value.some((url) => urlKey(url) !== fetched);
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
