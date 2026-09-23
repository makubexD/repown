// One reading of the whole picture, so every command agrees rather than each
// asking its own slightly different question.
//
// Split in two because the two halves have different lifetimes. The REPO state
// is per clone and cheap. The AUTH state is machine-wide, costs subprocesses
// (`git --exec-path`, GCM, gh) and is identical for every clone on the machine --
// so `repown scan`, which walks seventeen repositories, reads it once and hands it
// down rather than paying for it seventeen times.

import { Git, type ConfigEntry } from './git.ts';
import { parseGitUrl, type GitUrl } from './url.ts';
import { providerFor, type HostProvider } from './hosts/index.ts';
import { readIdentity, type RepoIdentity } from './identity.ts';
import { guardState, type GuardState } from './guard/hook.ts';
import { findGcm, listAccounts } from './credential/gcm.ts';
import { ghState, ghInstalled, type GhState } from './credential/gh.ts';
import type { Result } from './result.ts';

const DEFAULT_PROBE_URL = 'https://github.com/';

export interface RepoState {
  readonly git: Git;
  readonly isRepo: boolean;
  readonly root: string | null;
  readonly branch: string | null;
  readonly originUrl: string | null;
  readonly url: GitUrl | null;
  readonly provider: HostProvider;
  /** Who owns the repository origin points at, per the provider's rules. */
  readonly owner: string | null;
  readonly identity: RepoIdentity;
  readonly credentialKeys: readonly string[];
  readonly guard: GuardState;
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

  const [root, branch, identity, guard, helper] = await Promise.all([
    isRepo ? git.root() : Promise.resolve(null),
    isRepo ? git.currentBranch() : Promise.resolve(null),
    readIdentity(git, credentialKeys[0] ?? null),
    isRepo ? guardState(git) : Promise.resolve<GuardState>('off'),
    git.getUrlMatch('credential.helper', originUrl ?? DEFAULT_PROBE_URL),
  ]);

  return {
    git, isRepo, root, branch, originUrl, url, provider,
    owner: url ? provider.ownerOf(url) : null,
    identity, credentialKeys, guard, helper,
  };
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
    helperIsGcm: helper !== null && /^manager/.test(helper),
    ghHelperOrigins,
  };
}

export function isGh(helper: string | null): boolean {
  return helper !== null && /auth\s+git-credential/.test(helper);
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
