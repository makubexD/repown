// GitHub. The one host whose mechanics were established empirically rather than
// assumed -- see ADR-001.
//
// The pin is `credential.https://github.com.username`, which Git Credential
// Manager reads to choose between the credentials it stores, one per account,
// keyed `git:https://<user>@github.com`. That is what makes switching
// unnecessary: each clone authenticates as its own account, permanently.
//
// Over SSH there is no credential helper at all -- the SSH key decides -- so an
// SSH remote pins no credential key rather than one that selects nothing.

import type { AccountKind, HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { credentialPrefix } from '../url.ts';
import { ghProfileField, ghProfileLookup } from '../credential/gh.ts';

const HOSTS = ['github.com', 'gist.github.com', 'www.github.com', 'ssh.github.com'];

export function githubProvider(): HostProvider {
  return {
    id: 'github',
    label: 'GitHub',
    matches: (url: GitUrl) => HOSTS.includes(url.host),
    ownerOf: (url: GitUrl) => url.segments[0] ?? null,
    credentialKeys,
    resolveProfile,
    accountKind,
  };
}

function credentialKeys(url: GitUrl): readonly string[] {
  return url.scheme === 'https' ? [`credential.${credentialPrefix(url)}.username`] : [];
}

async function resolveProfile(account: string): Promise<Profile | null> {
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
}

/**
 * The users endpoint answers for an organisation too, with type Organization.
 * Anything else, including a failed call, is unknown -- not a user.
 */
async function accountKind(login: string): Promise<AccountKind | null> {
  const found = await ghProfileLookup(login, 'type');
  if (found.missing) return 'missing';
  if (found.value === 'User') return 'user';
  if (found.value === 'Organization') return 'organization';
  return null;
}
