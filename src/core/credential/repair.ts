// Undoing `gh auth setup-git`, and nothing else.
//
// WHAT IT DID. `gh auth setup-git` writes two entries per host:
//
//   [credential "https://github.com"]
//       helper =                                  <- EMPTY
//       helper = !'.../gh.exe' auth git-credential
//
// gitcredentials(7) defines the empty value as RESETTING the helper list, so a
// perfectly good `credential.helper = manager` sitting underneath is discarded
// and gh becomes the only helper for that host.
//
// WHY THAT BREAKS. `gh auth git-credential` resolves the token by HOST and serves
// only the ACTIVE account: asked for any other account it returns nothing and
// exits 1, even when that account's token is in the same keyring. So while gh is
// the helper, every `gh auth switch` guarantees a password prompt for every
// repository pinned to a different account.
//
// Removing those entries hands the host back to whatever was configured
// underneath. It is reversible in one command -- `gh auth setup-git` puts them
// back exactly as they were.
//
// REPORTS AN OUTCOME PER ENTRY, not a list of successes. An earlier version
// appended only on exit 0 and discarded stderr, so a write it could not perform
// vanished from the report and a partial repair read as a smaller successful one.
// The system scope is the realistic case: reading it needs nothing, editing it is
// machine-wide and needs an elevated shell.

import type { Git, ConfigScope } from '../git.ts';

const SCOPES: readonly ConfigScope[] = ['local', 'global', 'system'];
const HOSTS = ['https://github.com', 'https://gist.github.com'];

export interface RemovalOutcome {
  readonly scope: ConfigScope;
  readonly key: string;
  readonly values: readonly string[];
  readonly removed: boolean;
}

/** What `repair` would remove, without removing it. */
export async function planRepair(git: Git): Promise<RemovalOutcome[]> {
  const found: RemovalOutcome[] = [];
  for (const scope of SCOPES) {
    for (const host of HOSTS) {
      const key = 'credential.' + host + '.helper';
      const values = await git.getAllConfig(key, scope);
      if (values.length > 0) found.push({ scope, key, values, removed: false });
    }
  }
  return found;
}

export async function repair(git: Git): Promise<RemovalOutcome[]> {
  const planned = await planRepair(git);
  const results: RemovalOutcome[] = [];
  for (const entry of planned) {
    const removed = await git.unsetConfig(entry.key, entry.scope);
    results.push({ ...entry, removed });
  }
  return results;
}

/**
 * An empty value is the list reset, and saying so is the whole point of showing
 * the values at all -- on its own the blank line reads like a formatting bug
 * rather than the thing that discarded the real helper.
 */
export function describeValue(value: string): string {
  return value.trim().length === 0
    ? '(empty -- resets the helper list, discarding what was configured before)'
    : value;
}
