// Where `git push` with no arguments sends a branch, and whether this clone can
// tell what is already there (ADR-025).
//
// `HEAD --not --remotes` only knows remote-tracking refs. A destination with none
// (a remote never fetched, an empty one, or a URL, which never gets any) may
// already hold commits that range calls unpushed, so a rebase from its base would
// rewrite published history. Nothing offline tells an empty remote from an
// unfetched one, and FETCH_HEAD is no answer: a FAILED fetch writes it too, and it
// belongs to whichever remote was fetched last. So the destination is only ever
// "known" (it has tracking refs) or "unknown", and a read that fails is unknown.

import type { Git } from './git.ts';
import { parseGitUrl } from './url.ts';

/** A destination no remote-tracking ref reaches. `key` is the config key that named the URL. */
export type UnknownDestination =
  | { readonly kind: 'remote'; readonly name: string }
  | { readonly kind: 'url'; readonly key: string; readonly remote: string | null };

interface Configured {
  readonly key: string;
  readonly value: string;
}

/** Null when the branch pushes nowhere, to `.` (this repository), or to a remote with tracking refs. */
export async function unknownDestination(git: Git, branch: string): Promise<UnknownDestination | null> {
  const remotes = await git.remotes();
  const set = await configuredTarget(git, branch);
  const name = set?.value ?? defaultRemote(remotes);
  if (!name || name === '.') return null;
  if (remotes.includes(name)) return await isTracked(git, name) ? null : { kind: 'remote', name };
  if (!set) return null;
  return { kind: 'url', key: set.key, remote: await remoteWithUrl(git, remotes, name) };
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

function defaultRemote(remotes: readonly string[]): string | null {
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0]! : null;
}

async function isTracked(git: Git, remote: string): Promise<boolean> {
  const found = await git.hasTrackingRefs(remote);
  return found.ok && found.value;
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
