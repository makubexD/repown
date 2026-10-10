// Provider resolution. Ordered, with `generic` always last so every URL resolves
// to something and no caller has to handle "no provider".

import type { AccountKind, HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { githubProvider } from './github.ts';
import { azureDevOpsProvider } from './azdo.ts';
import { genericProvider } from './generic.ts';

export function providers(): HostProvider[] {
  return [githubProvider(), azureDevOpsProvider(), genericProvider()];
}

export function providerFor(url: GitUrl | null): HostProvider {
  const all = providers();
  if (!url) return all[all.length - 1]!;
  return all.find((provider) => provider.matches(url)) ?? all[all.length - 1]!;
}

/**
 * What to tell someone about a login the host looked up, or null for a user or an
 * unknown. Only GitHub answers accountKind, so the words name github.com.
 */
export function loginKindProblem(kind: AccountKind | null | undefined, login: string): string | null {
  if (kind === 'missing') return 'github.com has no account named ' + login + ': check the spelling';
  if (kind === 'organization') return login + ' is an organisation on github.com, not an account you sign in as';
  return null;
}

/** The host's profile for a login, and a sentence when the host says it is no account or an organisation. */
export async function lookUpProfile(provider: HostProvider | undefined, account: string): Promise<{ profile: Profile; problem: string | null }> {
  if (!provider?.resolveProfile) return { profile: {}, problem: null };
  const { profile, kind } = provider.lookUp
    ? await provider.lookUp(account)
    : { profile: await provider.resolveProfile(account), kind: await provider.accountKind?.(account) };
  return { profile: profile ?? {}, problem: loginKindProblem(kind, account) };
}

export type { AccountKind, HostProvider, Profile } from './types.ts';
