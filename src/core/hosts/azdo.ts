// Azure DevOps.
//
// WHAT WAS ACTUALLY PROBED, on a machine with five Azure Repos clones:
//
//   remote  https://contoso.visualstudio.com/<project>/_git/<repo>
//           -- the legacy *.visualstudio.com form, where the ORGANISATION is the
//              subdomain and the first path segment is the PROJECT. The modern
//              form is https://dev.azure.com/<org>/<project>/_git/<repo>, where
//              the organisation is the first path segment instead. Both are live
//              in the wild, and they disagree about what the first segment means
//              -- which is exactly why this host cannot be left to the generic
//              provider, whose "first segment is the owner" would report the
//              project as the owner and let a push to another organisation pass.
//
//   system  credential.https://dev.azure.com.usehttppath = true
//           -- shipped by Git for Windows. It does NOT apply to a
//              *.visualstudio.com remote: different host, no match.
//
//   global  credential.azreposcredentialtype = pat
//           -- PAT mode rather than OAuth, which is why
//              `git-credential-manager azure-repos list` returns nothing here:
//              a PAT is stored against the generic credential key and never
//              appears in that namespace.
//
// SO CREDENTIALS ARE DELIBERATELY NOT PINNED HERE. `credentialKeys` is empty,
// and `repown` says so in as many words rather than writing a key that would look
// like configuration while selecting nothing. Commit identity is still pinned
// and every push is still guarded -- an author address is the same fact on any
// host.
//
// Making credential selection work here is a real piece of work: it needs the
// PAT-vs-OAuth paths separated and each verified against a live remote. Until
// that happens this provider claims only what was measured.

import type { HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { err, type Result } from '../result.ts';

const MODERN_HOST = 'dev.azure.com';
const LEGACY_SUFFIX = '.visualstudio.com';
/** SSH remotes: `git@ssh.dev.azure.com:v3/<org>/...` and `<org>@vs-ssh.visualstudio.com:v3/<org>/...`. */
const SSH_HOSTS = ['ssh.dev.azure.com', 'vs-ssh.visualstudio.com'];

export function azureDevOpsProvider(): HostProvider {
  return {
    id: 'azdo',
    label: 'Azure DevOps',
    matches,
    ownerOf,
    credentialKeys: () => [],
    listStoredAccounts: async (): Promise<Result<string[]>> =>
      err('Azure DevOps credentials are not pinned by repown -- see src/core/hosts/azdo.ts'),
    resolveProfile: async (): Promise<Profile | null> => null,
  };
}

function matches(url: GitUrl): boolean {
  return url.host === MODERN_HOST || url.host.endsWith(LEGACY_SUFFIX) || SSH_HOSTS.includes(url.host);
}

/** The ORGANISATION: the subdomain in one URL form, a path segment in the others. */
function ownerOf(url: GitUrl): string | null {
  if (SSH_HOSTS.includes(url.host)) return url.segments[0] === 'v3' ? url.segments[1] ?? null : null;
  if (url.host === MODERN_HOST) return url.segments[0] ?? null;
  const subdomain = url.host.slice(0, -LEGACY_SUFFIX.length);
  return subdomain.length > 0 ? subdomain : null;
}
