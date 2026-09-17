// GitHub. The one host whose mechanics were established empirically rather than
// assumed -- see contrib/fork/ADR-IDENTITY.md in the repository this was
// extracted from.
//
// The pin is `credential.https://github.com.username`, which Git Credential
// Manager reads to choose between the credentials it stores, one per account,
// keyed `git:https://<user>@github.com`. That is what makes switching
// unnecessary: each clone authenticates as its own account, permanently.

import type { HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { credentialPrefix } from '../url.ts';
import { findGcm, listAccounts } from '../credential/gcm.ts';
import { ghProfileField } from '../credential/gh.ts';
import type { Result } from '../result.ts';

const HOSTS = ['github.com', 'gist.github.com', 'www.github.com'];

export function githubProvider(): HostProvider {
  return {
    id: 'github',
    label: 'GitHub',
    matches: (url: GitUrl) => HOSTS.includes(url.host),
    ownerOf: (url: GitUrl) => url.segments[0] ?? null,
    credentialKeys: (url: GitUrl) => [`credential.${credentialPrefix(url)}.username`],
    listStoredAccounts: async (): Promise<Result<string[]>> =>
      listAccounts(await findGcm(), 'github'),
    resolveProfile: async (account: string): Promise<Profile | null> => {
      const [name, id] = await Promise.all([
        ghProfileField(account, 'name'),
        ghProfileField(account, 'id'),
      ]);
      // GitHub's own noreply address: publishable by design, and it still links
      // the commit to the account. Offered as a default so a private address
      // need never be published to get working attribution.
      const email = id ? `${id}+${account}@users.noreply.github.com` : undefined;
      if (!name && !email) return null;
      return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
    },
  };
}
