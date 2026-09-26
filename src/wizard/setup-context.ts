// Everything `repown setup` needs to know before its first question, read once and
// read-only: the registry, this clone (origin, owner, pin, hook), and the machine
// (gh, the credential helper). Nothing here writes.

import type { Git } from '../core/git.ts';
import { inspectRepo, inspectAuth, type RepoState } from '../core/inspect.ts';
import { pinHolds } from '../core/identity.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import { planRepair } from '../core/credential/repair.ts';
import { isGh } from '../core/credential/gh.ts';
import { providers, type Profile } from '../core/hosts/index.ts';
import { ok, err, type Result } from '../core/result.ts';
import { previewLines } from '../commands/fix.ts';
import type { SetupContext } from './setup-flow.ts';

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
  const [auth, pinned, allowed, planned, addresses, helpers] = await Promise.all([
    inspectAuth(git, repo.originUrl ?? undefined),
    git.getConfig('repown.account', 'local'),
    git.getAllConfig('repown.allowOwner', 'local'),
    planRepair(git),
    historyFor(git, repo),
    git.getAllConfigRaw('credential.helper'),
  ]);
  const recorded = registry.value.accounts;
  // gh anywhere in the helper list may answer sign-ins: git asks the helpers in order.
  const ghIsHelper = auth.ghIsHelper || planned.length > 0 || helpers.some(isGh);
  return ok({
    cwd, recorded, pinned,
    pinIntact: await pinIntact(git, pinned, recorded[pinned ?? ''], repo),
    // Without an origin there is no host to go by; GitHub is only the default offered.
    host: repo.url ? repo.provider.id : 'github',
    owner: repo.owner,
    allowed: allowed.map((owner) => owner.toLowerCase()),
    credentialPinned: repo.credentialKeys.length > 0,
    gh: auth.ghPresent ? auth.gh : null,
    ghIsHelper,
    guard: repo.guard,
    redirected: repo.hook?.redirected ?? false,
    fixLines: repo.provider.id === 'github' && ghIsHelper && planned.length > 0 ? previewLines(planned) : null,
    addresses,
    suggest: suggester(),
  });
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
