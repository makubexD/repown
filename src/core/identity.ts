// This clone's identity: who authors its commits, and which stored account its
// pushes authenticate as.
//
// IT IS ALL PLAIN GIT CONFIG, DELIBERATELY. An earlier design kept a JSON
// profile store with capture/define/use/list/forget/restore around it, to switch
// identity inside one clone. Nothing needs that: a clone belongs to ONE account
// permanently. What you switch is the CLI's active account, which is a
// machine-wide mode and the CLI's own business.
//
// So the identity lives in .git/config -- per clone, never tracked, already the
// place git looks. No bespoke store, no snapshot, no second format, and nothing
// for a public repository to leak.
//
// NO NAMES OR ADDRESSES APPEAR IN THIS FILE.

import type { Git, ConfigScope } from './git.ts';

export const NAME_KEY = 'user.name';
export const EMAIL_KEY = 'user.email';
export const USE_CONFIG_ONLY_KEY = 'user.useConfigOnly';
/**
 * The account this clone belongs to, on ANY host. The credential key names it
 * too, but only on a host whose credentials repown pins (GitHub over https);
 * the guard's destination check needs it everywhere.
 */
export const ACCOUNT_KEY = 'repown.account';

export interface IdentityValues {
  readonly name: string;
  readonly email: string;
  readonly account: string;
}

export interface RepoIdentity {
  /** Set on this clone. */
  readonly name: string | null;
  readonly email: string | null;
  /** The credential key's account: who pushes authenticate as. */
  readonly account: string | null;
  /** repown.account: whose clone this is, whatever the host. */
  readonly owner: string | null;
  readonly useConfigOnly: string | null;
  /**
   * What git would EFFECTIVELY use, global config included. The difference
   * between this and the local reading is the whole point: an effective-only
   * value is inherited from the machine, and on a machine whose global identity
   * is a work account, inheriting is exactly the failure to catch.
   */
  readonly inheritedName: string | null;
  readonly inheritedEmail: string | null;
  readonly inheritedAccount: string | null;
}

export function isPinned(identity: RepoIdentity): boolean {
  return Boolean(identity.name && identity.email);
}

export async function readIdentity(git: Git, credentialKey: string | null): Promise<RepoIdentity> {
  const [name, email, useConfigOnly, owner] = await Promise.all([
    git.getConfig(NAME_KEY, 'local'),
    git.getConfig(EMAIL_KEY, 'local'),
    git.getConfig(USE_CONFIG_ONLY_KEY, 'local'),
    git.getConfig(ACCOUNT_KEY, 'local'),
  ]);
  const [inheritedName, inheritedEmail] = await Promise.all([
    git.getConfig(NAME_KEY),
    git.getConfig(EMAIL_KEY),
  ]);
  const account = credentialKey ? await git.getConfig(credentialKey, 'local') : null;
  const inheritedAccount = credentialKey ? await git.getConfig(credentialKey) : null;

  return {
    name, email, account, owner, useConfigOnly,
    inheritedName, inheritedEmail, inheritedAccount,
  };
}

export interface PinOutcome {
  readonly key: string;
  readonly value: string;
  readonly written: boolean;
}

/**
 * Writes the identity to `scope`, plus user.useConfigOnly so git refuses to
 * invent an identity from the hostname rather than silently using one. That does
 * NOT stop inheritance of an explicitly-set global address -- which is what the
 * commit-range check in the guard is for, not a substitute for it.
 */
export async function pinIdentity(
  git: Git,
  values: IdentityValues,
  credentialKeys: readonly string[],
  scope: ConfigScope = 'local',
): Promise<PinOutcome[]> {
  const writes: Array<[string, string]> = [
    [NAME_KEY, values.name],
    [EMAIL_KEY, values.email],
    [USE_CONFIG_ONLY_KEY, 'true'],
    [ACCOUNT_KEY, values.account],
    ...credentialKeys.map((key): [string, string] => [key, values.account]),
  ];
  return writeAll(writes, (key, value) => git.setConfig(key, value, scope));
}

export async function clearIdentity(
  git: Git,
  credentialKeys: readonly string[],
  scope: ConfigScope = 'local',
): Promise<PinOutcome[]> {
  const keys = [NAME_KEY, EMAIL_KEY, USE_CONFIG_ONLY_KEY, ACCOUNT_KEY, ...credentialKeys];
  return writeAll(keys.map((key): [string, string] => [key, '']),
                  (key) => git.unsetConfig(key, scope));
}

/**
 * ONE AT A TIME, NEVER Promise.all.
 *
 * `git config --local` writes through a `.lock` file in the config's own
 * directory, so concurrent invocations race for it and the losers fail --
 * quietly, because each is a separate process exiting non-zero rather than
 * throwing. Running these four in parallel dropped exactly one key per
 * repository across a twenty-repository rollout, most often `user.name`, and
 * every command still reported success because the write results were
 * discarded.
 *
 * Which is the failure this whole tool exists to prevent: a repository that
 * reports itself configured while its commits carry the machine's identity. So
 * the outcomes are returned, and callers are expected to look at them.
 */
async function writeAll(
  entries: ReadonlyArray<[string, string]>,
  write: (key: string, value: string) => Promise<boolean>,
): Promise<PinOutcome[]> {
  const outcomes: PinOutcome[] = [];
  for (const [key, value] of entries) {
    outcomes.push({ key, value, written: await write(key, value) });
  }
  return outcomes;
}
