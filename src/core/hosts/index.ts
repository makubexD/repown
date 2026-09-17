// Provider resolution. Ordered, with `generic` always last so every URL resolves
// to something and no caller has to handle "no provider".

import type { HostProvider } from './types.ts';
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

export type { HostProvider, Profile } from './types.ts';
