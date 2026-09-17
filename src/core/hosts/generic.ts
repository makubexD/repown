// The provider for every host no other provider claims.
//
// It pins commit identity and it guards pushes, because an author address is the
// same fact on any host. It does NOT pretend to select credentials: an unknown
// host's credential model is unknown, and half-working credential config is
// worse than none -- it looks configured while doing nothing.

import type { HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { err, type Result } from '../result.ts';

export function genericProvider(): HostProvider {
  return {
    id: 'generic',
    label: 'this host',
    matches: () => true,
    ownerOf: (url: GitUrl) => url.segments[0] ?? null,
    credentialKeys: () => [],
    listStoredAccounts: async (): Promise<Result<string[]>> =>
      err('no credential store is known for this host'),
    resolveProfile: async (): Promise<Profile | null> => null,
  };
}
