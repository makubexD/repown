// A host provider: everything that differs between GitHub, Azure DevOps and
// whatever comes next, behind one interface.
//
// Strategy rather than a chain of `if (host === ...)`, so adding a host is a new
// file and a registry entry, and so the parts that are NOT host-specific --
// commit identity, the guard, the account registry -- never learn about hosts at
// all. Author email is host-independent, which is why the guard keeps working on
// a host no provider claims.

import type { GitUrl } from '../url.ts';

export interface Profile {
  readonly name?: string;
  readonly email?: string;
}

export interface HostProvider {
  /** Stable identifier used in output and in the account registry. */
  readonly id: string;
  readonly label: string;

  matches(url: GitUrl): boolean;

  /** The account or organisation that owns the repository, or null. */
  ownerOf(url: GitUrl): string | null;

  /**
   * The git config keys that pin which stored account serves this remote.
   *
   * EMPTY MEANS THE HOST HAS NO PER-ACCOUNT PIN -- an honest "cannot do that
   * here", never a silent no-op. Commit identity is still pinned and the guard
   * still runs; only credential selection is unavailable.
   */
  credentialKeys(url: GitUrl): readonly string[];

  /** Best-effort name/email lookup, to save the user retyping. Optional. */
  resolveProfile?(account: string): Promise<Profile | null>;
}
