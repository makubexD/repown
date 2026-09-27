// Everything `repown setup` needs to know before its first question, read once and
// read-only: the registry, this clone (origin, owner, pin, hook), and the machine
// (gh, the credential helper, the global identity). Nothing here writes.

import type { Git } from '../core/git.ts';
import { inspectRepo, inspectAuth, type AuthState, type RepoState } from '../core/inspect.ts';
import { pinHolds } from '../core/identity.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import { planRepair, type RemovalOutcome } from '../core/credential/repair.ts';
import { isGh, type GhState } from '../core/credential/gh.ts';
import { providers, type Profile } from '../core/hosts/index.ts';
import { ok, err, type Result } from '../core/result.ts';
import { previewLines } from '../commands/fix.ts';
import type { DetectedAccount, SetupContext } from './setup-flow.ts';

const OWNS = 'owns this repository';
const SIGNED_IN = 'signed in to gh';
const STORED_IN = 'stored in Git Credential Manager';

export interface DetectionInput {
  /** False for any origin that is not GitHub: owner, gh and GCM are GitHub's only. */
  readonly github: boolean;
  readonly owner: string | null;
  /** False only when the owner is known to be an organisation. Null keeps the owner. */
  readonly ownerIsUser: boolean | null;
  readonly gh: Result<readonly string[]> | null;
  readonly stored: Result<readonly string[]> | null;
  readonly recorded: readonly string[];
}

interface Sighting {
  readonly login: string;
  readonly from: string;
}

/**
 * Candidate logins not already recorded, one entry each. The first spelling
 * wins; every source joins it, in the order owner, gh, then Git Credential
 * Manager. A failed lookup contributes nothing: it only shortens a suggestion
 * list, and the failure itself stays a Result. An organisation owner is left
 * out of every source; an owner of unknown kind is kept.
 */
export function detectedAccounts(input: DetectionInput): DetectedAccount[] {
  if (!input.github) return [];
  const found = new Map<string, { login: string; from: string[] }>();
  const taken = takenLogins(input);
  for (const sighting of sightings(input)) note(found, sighting, taken);
  return [...found.values()];
}

function sightings(input: DetectionInput): Sighting[] {
  return [
    ...ownerSighting(input),
    ...tagged(input.gh, SIGNED_IN),
    ...tagged(input.stored, STORED_IN),
  ];
}

function ownerSighting(input: DetectionInput): Sighting[] {
  if (!input.owner) return [];
  return [{ login: input.owner, from: OWNS }];
}

/** A failed or absent lookup is no logins. That is a shorter list, not a passed check. */
function tagged(result: Result<readonly string[]> | null, from: string): Sighting[] {
  if (!result?.ok) return [];
  return result.value.map((login) => ({ login, from }));
}

/** Recorded accounts, plus an owner known to be an organisation: never an account name. */
function takenLogins(input: DetectionInput): Set<string> {
  const taken = new Set(input.recorded.map((account) => account.toLowerCase()));
  if (input.owner && input.ownerIsUser === false) taken.add(input.owner.toLowerCase());
  return taken;
}

function note(
  found: Map<string, { login: string; from: string[] }>,
  sighting: Sighting,
  taken: ReadonlySet<string>,
): void {
  const key = sighting.login.toLowerCase();
  if (taken.has(key)) return;
  const existing = found.get(key);
  if (!existing) found.set(key, { login: sighting.login, from: [sighting.from] });
  else if (!existing.from.includes(sighting.from)) existing.from.push(sighting.from);
}

/**
 * The registry, refused when saving to it would drop entries it can't read. An entry
 * with an empty name or email counts as not recorded: `use` would stop and ask for it.
 */
export async function readRegistry(): Promise<Result<Registry>> {
  const registry = await loadRegistry();
  if (!registry.ok) return registry;
  // No prototype, as in the registry itself: an account named like a built-in must not collide.
  const accounts = Object.assign(Object.create(null) as Record<string, Account>,
    Object.fromEntries(Object.entries(registry.value.accounts).filter(([, entry]) => entry.name && entry.email)));
  if (registry.value.unreadable.length === 0) return ok({ ...registry.value, accounts });
  return err('the account registry has entries repown cannot read (' + registry.value.unreadable.join(', ') +
             ') -- fix or remove them first');
}

export async function readContext(git: Git, cwd: string | null): Promise<Result<SetupContext>> {
  const registry = await readRegistry();
  if (!registry.ok) return registry;
  const repo = await inspectRepo(git);
  const recorded = registry.value.accounts;
  const facts = await readFacts(git, repo, recorded);
  return ok(assemble(cwd, recorded, repo, facts));
}

interface Facts {
  readonly pinned: string | null;
  readonly pinIntact: boolean;
  readonly allowed: readonly string[];
  readonly gh: Result<GhState> | null;
  readonly ghIsHelper: boolean;
  readonly addresses: Result<ReadonlyMap<string, number>>;
  readonly fixLines: readonly string[] | null;
  readonly detected: readonly DetectedAccount[];
  readonly ownerIsUser: boolean | null;
  readonly name: string | null;
  readonly email: string | null;
}

async function readFacts(git: Git, repo: RepoState, recorded: Readonly<Record<string, Account>>): Promise<Facts> {
  const [auth, pinned, allowed, planned, addresses, helpers, name, email, ownerIsUser] = await Promise.all([
    inspectAuth(git, repo.originUrl ?? undefined),
    git.getConfig('repown.account', 'local'),
    git.getAllConfig('repown.allowOwner', 'local'),
    planRepair(git),
    historyFor(git, repo),
    git.getAllConfigRaw('credential.helper'),
    git.getConfig('user.name', 'global'),
    git.getConfig('user.email', 'global'),
    askOwnerIsUser(repo),
  ]);
  const ghIsHelper = anyGhHelper(auth, planned, helpers);
  return {
    pinned, allowed, addresses, name, email, ownerIsUser, ghIsHelper,
    gh: auth.ghPresent ? auth.gh : null,
    pinIntact: await pinIntact(git, pinned, recorded[pinned ?? ''], repo),
    detected: detectedAccounts(detectionOf(repo, auth, recorded, ownerIsUser)),
    fixLines: fixPreview(repo, ghIsHelper, planned),
  };
}

function assemble(cwd: string | null, recorded: Readonly<Record<string, Account>>, repo: RepoState, facts: Facts): SetupContext {
  return {
    cwd, recorded,
    pinned: facts.pinned,
    pinIntact: facts.pinIntact,
    host: offeredHost(repo),
    owner: repo.owner,
    detected: facts.detected,
    ownerIsUser: facts.ownerIsUser,
    allowed: facts.allowed.map((owner) => owner.toLowerCase()),
    credentialPinned: repo.credentialKeys.length > 0,
    gh: facts.gh,
    ghIsHelper: facts.ghIsHelper,
    guard: repo.guard,
    redirected: repo.hook?.redirected ?? false,
    fixLines: facts.fixLines,
    addresses: facts.addresses,
    machineIdentity: { name: facts.name, email: facts.email },
    suggest: suggester(),
  };
}

/** gh anywhere in the helper list may answer sign-ins: git asks the helpers in order. */
function anyGhHelper(auth: AuthState, planned: readonly RemovalOutcome[], helpers: readonly string[]): boolean {
  return auth.ghIsHelper || planned.length > 0 || helpers.some(isGh);
}

/** Without an origin there is no host to go by; GitHub is only the default offered. */
function offeredHost(repo: RepoState): string {
  return repo.url ? repo.provider.id : 'github';
}

function fixPreview(repo: RepoState, ghIsHelper: boolean, planned: readonly RemovalOutcome[]): readonly string[] | null {
  if (repo.provider.id !== 'github' || !ghIsHelper || planned.length === 0) return null;
  return previewLines(planned);
}

function detectionOf(
  repo: RepoState,
  auth: AuthState,
  recorded: Readonly<Record<string, Account>>,
  ownerIsUser: boolean | null,
): DetectionInput {
  return {
    github: repo.provider.id === 'github',
    owner: repo.owner,
    ownerIsUser,
    gh: ghLogins(auth.gh),
    stored: auth.stored,
    recorded: Object.keys(recorded),
  };
}

function ghLogins(gh: Result<GhState>): Result<readonly string[]> {
  if (!gh.ok) return gh;
  return ok(gh.value.accounts.map((account) => account.login));
}

/** Null unless this is GitHub, there is an owner, and the provider can classify it. */
async function askOwnerIsUser(repo: RepoState): Promise<boolean | null> {
  const ask = repo.provider.accountKind;
  if (repo.provider.id !== 'github' || !repo.owner || !ask) return null;
  return asUser(await ask(repo.owner));
}

function asUser(kind: 'user' | 'organization' | null): boolean | null {
  if (kind === 'user') return true;
  if (kind === 'organization') return false;
  return null;
}

/** The history is read only for the guard question, which needs it; it can be long. */
function historyFor(git: Git, repo: RepoState): Promise<Result<ReadonlyMap<string, number>>> {
  const guardAsked = repo.guard === 'off' && !repo.hook?.redirected;
  return guardAsked ? git.emailCounts() : Promise.resolve(ok(new Map<string, number>()));
}

/**
 * Whether `use <pinned>` would write nothing new AND git would use what it wrote: the
 * pinned account, as recorded, holds in .git/config, and nothing git reads besides it
 * -- an include, worktree config, a credential entry for the same URL spelt otherwise --
 * says something else.
 */
async function pinIntact(git: Git, pinned: string | null, entry: Account | undefined, repo: RepoState): Promise<boolean> {
  if (!pinned || !entry) return false;
  const values = { name: entry.name, email: entry.email, account: pinned };
  const [written, used] = await Promise.all([pinHolds(git, values, repo.credentialKeys), gitUses(git, values, repo)]);
  return written && used;
}

/** The identity and push account git resolves for this clone, from every scope it reads. */
async function gitUses(git: Git, values: { name: string; email: string; account: string }, repo: RepoState): Promise<boolean> {
  const pinsCredential = repo.credentialKeys.length > 0 && repo.originUrl !== null;
  const [name, email, user] = await Promise.all([
    git.getConfig('user.name'),
    git.getConfig('user.email'),
    pinsCredential ? git.getUrlMatch('credential.username', repo.originUrl!) : Promise.resolve(values.account),
  ]);
  return name === values.name && email === values.email && user === values.account;
}

/** Profile lookups are network calls: one per account and host, however often a step is re-asked. */
function suggester(): (account: string, host: string) => Promise<Profile> {
  const cache = new Map<string, Promise<Profile>>();
  return (account, host) => {
    const key = host + '\n' + account;
    if (!cache.has(key)) {
      const provider = providers().find((candidate) => candidate.id === host);
      cache.set(key, (provider?.resolveProfile?.(account) ?? Promise.resolve(null)).then((found) => found ?? {}));
    }
    return cache.get(key)!;
  };
}
