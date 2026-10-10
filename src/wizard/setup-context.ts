// Everything `repown setup` needs to know before its first question, read once and
// read-only: the registry, this clone (origin, owner, pin, hook, push.autoSetupRemote),
// and the machine (gh, the credential helper, the global identity, git's version).
// Nothing here writes.

import type { CurrentBranch, Git } from '../core/git.ts';
import { gitSupportsAutoUpstream } from '../core/version.ts';
import { inspectRepo, inspectAuth, pinsCredential, type AuthState, type RepoState } from '../core/inspect.ts';
import { pinHolds } from '../core/identity.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import { planRepair, type RemovalOutcome } from '../core/credential/repair.ts';
import { isGh, type GhState } from '../core/credential/gh.ts';
import { lookUpProfile, providers, type AccountKind } from '../core/hosts/index.ts';
import { ok, err, type Result } from '../core/result.ts';
import { previewLines } from '../commands/fix.ts';
import { readUnpushed, type UnpushedFact } from '../core/unpushed.ts';
import { readPushFacts } from '../core/push-state.ts';
import { SOURCE_GCM, SOURCE_GH, SOURCE_OWNS, signedInLogins, type DetectedAccount, type SetupContext, type Suggestion, type UpstreamRead } from './setup-flow.ts';
import { snapshotOf } from '../core/config-snapshot.ts';

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
    ...tagged(input.gh, SOURCE_GH),
    ...tagged(input.stored, SOURCE_GCM),
  ];
}

function ownerSighting(input: DetectionInput): Sighting[] {
  if (!input.owner) return [];
  return [{ login: input.owner, from: SOURCE_OWNS }];
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

export interface ReadOptions {
  /** False when setup will not prompt: the kind is unused, so this path never calls gh api. */
  readonly classifyOwner?: boolean;
  /** When set, classifies the owner instead of the provider. Tests pass a spy. */
  readonly accountKind?: (login: string) => Promise<AccountKind | null>;
  /** Tests pass the auth snapshot. Production reads it. */
  readonly auth?: AuthState;
}

export async function readContext(git: Git, cwd: string | null, options: ReadOptions = {}): Promise<Result<SetupContext>> {
  const registry = await readRegistry();
  if (!registry.ok) return registry;
  // Read-only: one list per scope answers every config read of this context (ADR-029).
  const view = snapshotOf(git);
  const repo = await inspectRepo(view);
  const recorded = registry.value.accounts;
  const facts = await readFacts(view, repo, recorded, options);
  return ok(assemble(cwd, recorded, repo, facts));
}

interface Facts {
  readonly push: SetupContext['push'];
  readonly pinned: string | null;
  readonly pinIntact: boolean;
  readonly allowed: readonly string[];
  readonly gh: Result<GhState> | null;
  readonly ghIsHelper: boolean;
  readonly addresses: Result<ReadonlyMap<string, number>>;
  readonly unpushed: UnpushedFact;
  readonly fixLines: readonly string[] | null;
  readonly detected: readonly DetectedAccount[];
  readonly ownerIsUser: boolean | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly upstream: UpstreamRead;
  readonly stored: Result<readonly string[]>;
}

async function readFacts(git: Git, repo: RepoState, recorded: Readonly<Record<string, Account>>, options: ReadOptions): Promise<Facts> {
  const loaded = await loadClone(git, repo, options);
  return finishFacts(git, repo, recorded, loaded);
}

interface Loaded {
  readonly push: SetupContext['push'];
  readonly auth: AuthState;
  readonly pinned: string | null;
  readonly allowed: readonly string[];
  readonly planned: readonly RemovalOutcome[];
  readonly addresses: Result<ReadonlyMap<string, number>>;
  readonly unpushed: UnpushedFact;
  readonly helpers: readonly string[];
  readonly name: string | null;
  readonly email: string | null;
  readonly ownerIsUser: boolean | null;
  readonly upstream: UpstreamRead;
}

async function loadClone(git: Git, repo: RepoState, options: ReadOptions): Promise<Loaded> {
  const authPromise = options.auth ? Promise.resolve(options.auth) : inspectAuth(git, repo.credentialUrl ?? undefined);
  const [auth, pinned, allowed, planned, addresses, helpers, ownerIsUser, upstream, [unpushed, push]] = await Promise.all([
    authPromise,
    git.getConfig('repown.account', 'local'),
    git.getAllConfig('repown.allowOwner', 'local'),
    planRepair(git),
    historyFor(git, repo),
    git.getAllConfigRaw('credential.helper'),
    authPromise.then((auth) => askOwnerIsUser(repo, auth, options)),
    readUpstream(git),
    readUnpushedAndPush(git),
  ]);
  const { machineName: name, machineEmail: email } = repo.identity;
  return { auth, pinned, allowed, planned, addresses, unpushed, push, helpers, name, email, ownerIsUser, upstream };
}

/** The push facts reuse the unpushed read; `unpushed` stays its own field, as tests set it alone. */
async function readUnpushedAndPush(git: Git): Promise<[UnpushedFact, SetupContext['push']]> {
  const unpushed = await readUnpushed(git);
  const { unpushed: _, ...push } = await readPushFacts(git, unpushed);
  return [unpushed, push];
}

/** Version, effective push.autoSetupRemote, the branch and its tracked ref. One read; nothing is written. */
async function readUpstream(git: Git): Promise<UpstreamRead> {
  const [version, enabled, head, tracked] = await Promise.all([
    git.version(), git.getBoolConfig('push.autoSetupRemote'), git.currentBranch(), git.upstreamRef(),
  ]);
  return {
    supported: gitSupportsAutoUpstream(version ?? ''), enabled,
    branch: branchOf(head), tracked: trackedOf(head, tracked),
  };
}

function branchOf(head: CurrentBranch | null): string | null {
  return head?.kind === 'branch' ? head.name : null;
}

function trackedOf(head: CurrentBranch | null, tracked: string | null): string | null {
  return head?.kind === 'branch' ? tracked : null;
}

async function finishFacts(git: Git, repo: RepoState, recorded: Readonly<Record<string, Account>>, loaded: Loaded): Promise<Facts> {
  const ghIsHelper = anyGhHelper(loaded.auth, loaded.planned, loaded.helpers);
  return {
    pinned: loaded.pinned, allowed: loaded.allowed, addresses: loaded.addresses, unpushed: loaded.unpushed, push: loaded.push,
    name: loaded.name, email: loaded.email, ownerIsUser: loaded.ownerIsUser, ghIsHelper, stored: loaded.auth.stored,
    gh: loaded.auth.ghPresent ? loaded.auth.gh : null,
    pinIntact: await pinIntact(git, loaded.pinned, recorded[loaded.pinned ?? ''], repo),
    detected: detectedAccounts(detectionOf(repo, loaded.auth, recorded, loaded.ownerIsUser)),
    fixLines: fixPreview(repo, ghIsHelper, loaded.planned),
    upstream: loaded.upstream,
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
    credentialPinned: pinsCredential(repo), credentialKeys: repo.credentialKeys,
    gh: facts.gh, ghIsHelper: facts.ghIsHelper,
    guard: repo.guard,
    redirected: repo.hook?.redirected ?? false, hookPath: repo.hook?.path ?? null,
    fixLines: facts.fixLines,
    addresses: facts.addresses, unpushed: facts.unpushed, push: facts.push,
    machineIdentity: { name: facts.name, email: facts.email },
    upstream: facts.upstream, stored: facts.stored,
    suggest: suggester(),
    signedIn: async () => signedInLogins(facts.gh, facts.stored),
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

/**
 * True when the owner is a user, false for an organisation, null when unknown.
 * A gh account on github.com is a user: gh lists sign-ins, never organisations.
 * No lookup when setup will not prompt. A recorded owner is still classified.
 */
export async function askOwnerIsUser(repo: RepoState, auth: AuthState, options: ReadOptions = {}): Promise<boolean | null> {
  if (options.classifyOwner === false) return null;
  if (repo.ownerProvider.id !== 'github' || !repo.owner) return null;
  if (signedIn(auth, repo.owner)) return true;
  const ask = options.accountKind ?? repo.ownerProvider.accountKind;
  if (!ask) return null;
  return asUser(await ask(repo.owner));
}

function signedIn(auth: AuthState, owner: string): boolean {
  if (!auth.gh.ok) return false;
  return auth.gh.value.accounts.some((account) => account.login.toLowerCase() === owner.toLowerCase());
}

function asUser(kind: AccountKind | null): boolean | null {
  if (kind === 'user') return true;
  if (kind === 'organization') return false;
  return null;
}

/** Every ref, for the guard question only. Unpushed commits on this branch are readUnpushed. */
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
  const pinned = pinsCredential(repo) && repo.credentialUrl !== null;
  const [name, email, user] = await Promise.all([
    git.getConfig('user.name'),
    git.getConfig('user.email'),
    pinned ? git.getUrlMatch('credential.username', repo.credentialUrl!) : Promise.resolve(values.account),
  ]);
  return name === values.name && email === values.email && user === values.account;
}

/** Profile lookups are network calls: one per account and host, however often a step is re-asked. */
export function suggester(): (account: string, host: string) => Promise<Suggestion> {
  const cache = new Map<string, Promise<Suggestion>>();
  return (account, host) => {
    const key = host + '\n' + account;
    if (!cache.has(key)) {
      const provider = providers().find((candidate) => candidate.id === host);
      cache.set(key, lookUpProfile(provider, account).then((found) => ({ ...found.profile, problem: found.problem })));
    }
    return cache.get(key)!;
  };
}
