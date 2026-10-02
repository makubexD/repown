// The profile lookup `accounts add` and setup share: a suggestion to save retyping, and a sentence when the
// host says the login is no account or an organisation. Never a refusal: offline still records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookUpProfile, type AccountKind, type HostProvider } from '../src/core/hosts/index.ts';

function host(kind: AccountKind | null, profile: { name?: string; email?: string } | null): HostProvider {
  return { resolveProfile: async () => profile, accountKind: async () => kind } as unknown as HostProvider;
}

test('a login github.com has no account for is still suggested, with a sentence saying so', async () => {
  assert.deepEqual(await lookUpProfile(host('missing', null), 'octocat'),
    { profile: {}, problem: 'github.com has no account named octocat: check the spelling' });
});

test('a user gets its profile and no sentence; an unknown kind is no sentence either', async () => {
  const profile = { name: 'Octo Cat', email: '1+octocat@users.noreply.github.com' };
  assert.deepEqual(await lookUpProfile(host('user', profile), 'octocat'), { profile, problem: null });
  assert.deepEqual(await lookUpProfile(host(null, null), 'octocat'), { profile: {}, problem: null });
});

test('an organisation gets a sentence; a host that looks nothing up gets nothing', async () => {
  assert.match((await lookUpProfile(host('organization', null), 'octo-org')).problem ?? '', /organisation/);
  assert.deepEqual(await lookUpProfile(undefined, 'octocat'), { profile: {}, problem: null });
  assert.deepEqual(await lookUpProfile({} as HostProvider, 'octocat'), { profile: {}, problem: null });
});
