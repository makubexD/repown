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

// WHERE IT IS. gh writes to the global file, but the pair may sit in any file a scope
// includes (a `~/.gitconfig.local` behind `include.path`), and git applies it from there.
// So each scope is read with its includes, and each key is edited in the file that holds
// it: `--global --unset-all` leaves an included file as it was (ADR-030).

import type { Git, ConfigScope, ConfigEntry } from '../git.ts';
import { isGh } from './gh.ts';

const SCOPES: readonly ConfigScope[] = ['local', 'global', 'system'];
/** The helper key of github.com and gist.github.com, the two hosts gh writes. */
const HELPER_KEYS = '^credential\\.https://(gist\\.)?github\\.com\\.helper$';

export interface RemovalOutcome {
  readonly scope: ConfigScope;
  /** The file that holds the key: the scope's own, or one it includes. */
  readonly file: string;
  readonly key: string;
  readonly values: readonly string[];
  readonly removed: boolean;
}

/**
 * What `repair` would remove, without removing it: on each key in each file, gh's
 * values and the empty reset gh writes with them. A key holding no gh value is not
 * listed, and any other helper on a listed key stays -- `gh auth setup-git`, the undo,
 * would never bring it back.
 */
export async function planRepair(git: Git): Promise<RemovalOutcome[]> {
  const read = await Promise.all(SCOPES.map((scope) => git.configOrigins(HELPER_KEYS, scope)));
  return SCOPES.flatMap((scope, index) => plannedIn(scope, read[index]!));
}

/** One outcome per (file, key) holding gh's value: gh writes its reset and value together. */
function plannedIn(scope: ConfigScope, entries: readonly ConfigEntry[]): RemovalOutcome[] {
  const byFileAndKey = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    const id = entry.file + '\0' + entry.key;
    byFileAndKey.set(id, [...(byFileAndKey.get(id) ?? []), entry]);
  }
  return [...byFileAndKey.values()].flatMap((group) => {
    const values = group.map((entry) => entry.value);
    if (!values.some(isGh)) return [];
    return [{ scope, file: group[0]!.file, key: group[0]!.key, values: ghEntries(values), removed: false }];
  });
}

/** gh's value, or an empty reset sitting directly before one -- the pair gh writes. */
function isGhEntry(values: readonly string[], index: number): boolean {
  const value = values[index]!;
  return isGh(value) || (value.trim().length === 0 && isGh(values[index + 1] ?? null));
}

function ghEntries(values: readonly string[]): string[] {
  return values.filter((_, index) => isGhEntry(values, index));
}

/**
 * git can remove a value by PATTERN, not by position -- and two empty resets are
 * the same pattern, only one of them gh's. So the key is rewritten in its file:
 * unset, then every value that is not gh's added back, in its original order.
 */
export async function repair(git: Git): Promise<RemovalOutcome[]> {
  const results: RemovalOutcome[] = [];
  for (const entry of await planRepair(git)) results.push({ ...entry, removed: await rewrite(git, entry) });
  return results;
}

/** That file's own values of the key (named outright, so not its includes), gh's left out. */
async function rewrite(git: Git, entry: RemovalOutcome): Promise<boolean> {
  const file = { file: entry.file };
  const all = await git.getAllConfigRaw(entry.key, file);
  const kept = all.filter((_, index) => !isGhEntry(all, index));
  let removed = await git.unsetConfig(entry.key, file);
  for (const value of kept) removed = await git.addConfig(entry.key, value, file) && removed;
  return removed;
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
