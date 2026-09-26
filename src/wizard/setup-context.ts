// Everything `repown setup` needs to know before its first question, read once and
// read-only: the registry, this clone (origin, owner, pin, hook), and the machine
// (gh, the credential helper). Nothing here writes.

import type { Git } from '../core/git.ts';
import { inspectRepo, inspectAuth, type RepoState } from '../core/inspect.ts';
import { pinHolds } from '../core/identity.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import { planRepair } from '../core/credential/repair.ts';
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
  const [auth, pinned, allowed, planned, addresses] = await Promise.all([
    inspectAuth(git, repo.originUrl ?? undefined),
    git.getConfig('repown.account', 'local'),
    git.getAllConfig('repown.allowOwner', 'local'),
    planRepair(git),
    historyFor(git, repo),
  ]);
  const recorded = registry.value.accounts;
  return ok({
    cwd, recorded, pinned,
    pinIntact: await pinIntact(git, pinned, recorded[pinned ?? ''], repo.credentialKeys),
    // Without an origin there is no host to go by; GitHub is only the default offered.
    host: repo.url ? repo.provider.id : 'github',
    owner: repo.owner,
    allowed: allowed.map((owner) => owner.toLowerCase()),
    credentialPinned: repo.credentialKeys.length > 0,
    gh: auth.ghPresent ? auth.gh : null,
    ghIsHelper: auth.ghIsHelper,
    guard: repo.guard,
    redirected: repo.hook?.redirected ?? false,
    fixLines: repo.provider.id === 'github' && auth.ghIsHelper && planned.length > 0 ? previewLines(planned) : null,
    addresses,
    suggest: suggester(),
  });
}

/** The history is read only for the guard question, which needs it; it can be long. */
function historyFor(git: Git, repo: RepoState): Promise<Result<ReadonlyMap<string, number>>> {
  const guardAsked = repo.guard === 'off' && !repo.hook?.redirected;
  return guardAsked ? git.emailCounts() : Promise.resolve(ok(new Map<string, number>()));
}

/** Whether `use <pinned>` would write nothing new: the pinned account, as recorded, holds in full. */
async function pinIntact(git: Git, pinned: string | null, entry: Account | undefined, credentialKeys: readonly string[]): Promise<boolean> {
  if (!pinned || !entry) return false;
  return pinHolds(git, { name: entry.name, email: entry.email, account: pinned }, credentialKeys);
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
