// Everything `repown setup` needs to know before its first question, read once and
// read-only: the registry, this clone (origin, owner, pin, hook), and the machine
// (gh, the credential helper). Nothing here writes.

import type { Git } from '../core/git.ts';
import { inspectRepo, inspectAuth } from '../core/inspect.ts';
import { loadRegistry, type Registry } from '../core/registry.ts';
import { planRepair } from '../core/credential/repair.ts';
import { providers, type Profile } from '../core/hosts/index.ts';
import { ok, err, type Result } from '../core/result.ts';
import { previewLines } from '../commands/fix.ts';
import type { SetupContext } from './setup-flow.ts';

/** The registry, refused when saving to it would drop entries it can't read. */
export async function readRegistry(): Promise<Result<Registry>> {
  const registry = await loadRegistry();
  if (!registry.ok || registry.value.unreadable.length === 0) return registry;
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
    git.emailCounts(),
  ]);
  return ok({
    cwd, recorded: registry.value.accounts, pinned,
    // Without an origin there is no host to go by; GitHub is only the default offered.
    host: repo.url ? repo.provider.id : 'github',
    owner: repo.owner,
    allowed: allowed.map((owner) => owner.toLowerCase()),
    credentialPinned: repo.credentialKeys.length > 0,
    gh: auth.ghPresent ? auth.gh : null,
    guard: repo.guard,
    redirected: repo.hook?.redirected ?? false,
    fixLines: repo.provider.id === 'github' && auth.ghIsHelper && planned.length > 0 ? previewLines(planned) : null,
    addresses,
    suggest: suggester(),
  });
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
