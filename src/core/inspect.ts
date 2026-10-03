// One reading of the whole picture, so every command agrees rather than each
// asking its own slightly different question.
//
// Split in two because the two halves have different lifetimes. The REPO state
// is per clone and cheap. The AUTH state is machine-wide, costs subprocesses
// (`git --exec-path`, GCM, gh) and is identical for every clone on the machine,
// so the commands that need it ask for it separately -- and `repown scan`, which
// walks many repositories, never asks for it at all.

import { Git, type ConfigEntry, type CurrentBranch } from './git.ts';
import { parseGitUrl, type GitUrl } from './url.ts';
import { providerFor, type HostProvider } from './hosts/index.ts';
import { readIdentity, type RepoIdentity } from './identity.ts';
import { guardState, hookLocation, type GuardState, type HookLocation } from './guard/hook.ts';
import { findGcm, listAccounts, isGcm } from './credential/gcm.ts';
import { ghState, ghInstalled, isGh, type GhState } from './credential/gh.ts';
import type { Result } from './result.ts';

const DEFAULT_PROBE_URL = 'https://github.com/';

export interface RepoState {
  readonly git: Git;
  readonly isRepo: boolean;
  readonly root: string | null;
  /** Branch HEAD names, or the short hash when detached. Null outside a repository. */
  readonly branch: CurrentBranch | null;
  readonly originUrl: string | null;
  readonly url: GitUrl | null;
  /** The host of origin's configured (fetch) URL: what the credential keys follow. */
  readonly provider: HostProvider;
  /** The owner origin's pushes go to (the URL git pushes to, as the guard sees it). */
  readonly owner: string | null;
  /** The host of that same push URL; it differs from `provider` only when pushes are rewritten elsewhere. */
  readonly ownerProvider: HostProvider;
  readonly identity: RepoIdentity;
  readonly credentialKeys: readonly string[];
  readonly guard: GuardState;
  /** Where git runs the pre-push hook from; null outside a repository. */
  readonly hook: HookLocation | null;
  /** The effective credential helper for THIS repository's remote. */
  readonly helper: string | null;
}

export interface AuthState {
  readonly gcmPath: string | null;
  readonly gcmPresent: boolean;
  readonly stored: Result<string[]>;
  readonly ghPresent: boolean;
  /** An error here means gh could not be QUERIED -- never "no account is active". */
  readonly gh: Result<GhState>;
  readonly helper: string | null;
  readonly ghIsHelper: boolean;
  readonly helperIsGcm: boolean;
  /** Where `gh auth setup-git` wrote its entries, so a repair edits the right scope. */
  readonly ghHelperOrigins: readonly ConfigEntry[];
}

export async function inspectRepo(git: Git): Promise<RepoState> {
  const isRepo = await git.isRepo();
  const originUrl = isRepo ? await git.getConfig('remote.origin.url') : null;
  const url = originUrl ? parseGitUrl(originUrl) : null;
  const provider = providerFor(url);
  const credentialKeys = url ? provider.credentialKeys(url) : [];

  const [root, branch, hook, identity, guard, helper, pushed] = await Promise.all([
    isRepo ? git.root() : Promise.resolve(null),
    isRepo ? git.currentBranch() : Promise.resolve(null),
    isRepo ? hookLocation(git) : Promise.resolve(null),
    readIdentity(git, credentialKeys[0] ?? null),
    isRepo ? guardState(git) : Promise.resolve<GuardState>('off'),
    git.getUrlMatch('credential.helper', originUrl ?? DEFAULT_PROBE_URL),
    pushSide(git, originUrl),
  ]);

  return {
    git, isRepo, root, branch, originUrl, url, provider,
    owner: pushed.owner, ownerProvider: pushed.provider,
    identity, credentialKeys, guard, hook, helper,
  };
}

/**
 * Who origin's pushes go to, and on which host: the URL git pushes to (pushurl,
 * pushInsteadOf, insteadOf), the one the guard checks, not the configured fetch URL the
 * credentials follow. The owner and its host always come from that same URL.
 */
async function pushSide(git: Git, originUrl: string | null): Promise<{ owner: string | null; provider: HostProvider }> {
  const pushed = originUrl ? parseGitUrl((await git.remotePushUrl('origin')) ?? originUrl) : null;
  const provider = providerFor(pushed);
  return { owner: pushed ? provider.ownerOf(pushed) : null, provider };
}

export async function inspectAuth(git: Git, probeUrl?: string): Promise<AuthState> {
  const gcmPath = await findGcm();
  const [stored, gh, present, helper, ghHelperOrigins] = await Promise.all([
    listAccounts(gcmPath, 'github'),
    ghState(),
    ghInstalled(),
    git.getUrlMatch('credential.helper', probeUrl ?? DEFAULT_PROBE_URL),
    git.configOrigins('credential\\..*github\\.com\\.helper'),
  ]);

  return {
    gcmPath,
    gcmPresent: gcmPath !== null,
    stored,
    ghPresent: present,
    gh,
    helper,
    ghIsHelper: isGh(helper),
    helperIsGcm: isGcm(helper),
    ghHelperOrigins,
  };
}

/**
 * How the active CLI account should be DISPLAYED. Three outcomes, never
 * collapsed into one another -- "unknown" is the entire point of keeping the
 * error case distinct from the empty case.
 */
export function activeAccountLabel(auth: AuthState): string {
  if (!auth.ghPresent) return 'not installed';
  if (!auth.gh.ok) return 'unknown -- gh could not be queried';
  return auth.gh.value.active ?? 'none';
}

export function storedAccountsLabel(auth: AuthState): string {
  if (!auth.gcmPresent) return 'not installed';
  if (!auth.stored.ok) return 'unknown -- ' + auth.stored.error;
  return auth.stored.value.length > 0 ? auth.stored.value.join(', ') : 'none stored yet';
}
