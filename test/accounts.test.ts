// The profile lookup `accounts add` and setup share: a suggestion to save retyping, and a sentence when the
// host says the login is no account or an organisation. Never a refusal: offline still records.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookUpProfile, type AccountKind, type HostProvider } from '../src/core/hosts/index.ts';
import { githubLogin, kindFrom, profileFrom } from '../src/core/hosts/github.ts';

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

test('only a GitHub-shaped login is looked up: a path, dots or other characters never reach the API', async () => {
  for (const login of ['octocat', 'octo-org', 'octo_work', 'A1']) assert.equal(githubLogin(login), true, login);
  for (const login of ['../user', '..', '.', 'a/b', 'a.b', '-x', 'octo cat', 'a?b', 'a#b', '', 'user%2F..']) {
    assert.equal(githubLogin(login), false, login);
  }
  const asked: string[] = [];
  const read = async (login: string, field: string): Promise<string | null> => {
    asked.push(login + ':' + field);
    return field === 'id' ? '1' : 'Octo Cat';
  };
  assert.equal(await profileFrom('../user', read), null);
  const lookup = async (login: string, field: string) => { asked.push(login + ':' + field); return { value: 'User', missing: false }; };
  assert.equal(await kindFrom('../user', lookup), 'missing', 'no github.com account can be spelled so: named, without asking');
  assert.equal(await kindFrom('octo.cat', lookup), 'missing');
  assert.deepEqual(asked, [], 'nothing was asked for a login that is not GitHub-shaped');
  assert.deepEqual(await profileFrom('octocat', read), { name: 'Octo Cat', email: '1+octocat@users.noreply.github.com' });
});

test('a profile name with control or bidi characters is dropped, never suggested or saved', async () => {
  const reading = (name: string) => async (_login: string, field: string): Promise<string | null> => (field === 'id' ? '7' : name);
  for (const name of ['Octo\x1b[2JCat', 'Octo‮Cat', 'Octo\nCat']) {
    assert.deepEqual(await profileFrom('octocat', reading(name)), { email: '7+octocat@users.noreply.github.com' }, JSON.stringify(name));
  }
  const odd = async (_login: string, field: string): Promise<string | null> => (field === 'id' ? '7; rm' : 'Octo Cat');
  assert.deepEqual(await profileFrom('octocat', odd), { name: 'Octo Cat' }, 'an id that is not digits makes no address');
});
