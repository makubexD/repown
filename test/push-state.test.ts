// What readPushFacts reads from a real clone: the facts blockers() turns into lines.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Git } from '../src/core/git.ts';
import { readUnpushed } from '../src/core/unpushed.ts';
import { readPushFacts } from '../src/core/push-state.ts';
import { sandbox, type Sandbox } from './helpers.ts';

const THEIRS = 'other@example.invalid';

describe('readPushFacts', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const read = async (env: NodeJS.ProcessEnv = {}) => {
    const git = new Git(box.dir);
    return readPushFacts(git, await readUnpushed(git), env);
  };
  const commit = (message: string, email = 'octocat@example.invalid'): void => {
    box.git('-c', 'user.email=' + email, '-c', 'user.name=Someone', 'commit', '-q', '--allow-empty', '-m', message);
  };
  const bare = (name: string): string => {
    const path = join(box.dir, '..', name + '.git');
    box.git('init', '-q', '--bare', path);
    return path;
  };

  test('a clean clone: nothing to report', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', bare('origin'));
    box.git('push', '-q', '-u', 'origin', 'main');
    const facts = await read();
    assert.deepEqual(facts.env, []);
    assert.deepEqual(facts.configOverrides, []);
    assert.equal(facts.signinKey, null);
    assert.deepEqual(facts.divergence, { ok: true, value: { tracked: 'origin/main', behind: 0, ahead: 0 } });
    assert.deepEqual(facts.elsewhere, { ok: true, value: [] });
    assert.equal(facts.detached, false);
    assert.equal(facts.upstream, 'set');
  });

  test('identity and token variables by name, and author.email / committer.email in config', async () => {
    commit('first');
    box.git('config', 'author.email', 'old@example.invalid');
    const facts = await read({ GIT_AUTHOR_EMAIL: 'x@example.invalid', GH_TOKEN: 'secret', GITHUB_TOKEN: '' });
    assert.deepEqual(facts.env, ['GIT_AUTHOR_EMAIL', 'GH_TOKEN']);
    assert.deepEqual(facts.configOverrides, ['author.email']);
  });

  test('a sign-in in the push path is found by key; a bare username is not a secret', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', 'https://octocat@github.com/octocat/hello.git');
    assert.equal((await read()).signinKey, null);
    box.git('config', 'branch.main.remote', 'https://octocat:tok@github.com/octocat/hello.git');
    assert.equal((await read()).signinKey, 'branch.main.remote');
    box.git('config', '--unset', 'branch.main.remote');
    box.git('config', 'remote.origin.pushurl', 'https://ghp_abc@github.com/octocat/hello.git');
    assert.equal((await read()).signinKey, 'remote.origin.pushurl');
    box.git('config', 'remote.origin.url', 'https://octocat:ghp_abc@github.com/octocat/hello.git');
    box.git('config', 'remote.origin.pushurl', 'https://github.com/octocat/hello.git');
    assert.equal((await read()).signinKey, null, 'a push uses the clean pushurl; the token in url signs in only fetches');
    box.git('config', '--unset', 'remote.origin.pushurl');
    assert.equal((await read()).signinKey, 'remote.origin.url');
    box.git('config', 'remote.origin.url', 'https://github.com/octocat/hello.git');
    box.git('config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic xyz');
    assert.equal((await read()).signinKey, 'http.https://github.com/.extraheader');
  });

  test('a URL where a remote would do: the key to repoint and that remote, never the URL', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/hello.git');
    assert.equal((await read()).repoint, null, 'a named remote needs no repoint');
    box.git('config', 'branch.main.remote', 'https://octocat:ghp_tok@github.com/octocat/hello.git');
    assert.deepEqual((await read()).repoint, { key: 'branch.main.remote', remote: 'origin', tracked: false });
    box.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.deepEqual((await read()).repoint, { key: 'branch.main.remote', remote: 'origin', tracked: true });
    box.git('config', 'branch.main.remote', 'https://octocat:ghp_tok@github.com/octocat/other.git');
    assert.equal((await read()).repoint, null, 'no remote has that repository');
  });

  test('the destination owner comes from the push target, with this clone\'s allowOwner', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/hello.git');
    box.git('remote', 'add', 'upstream', 'https://github.com/octo-org/hello.git');
    box.git('config', 'branch.main.pushRemote', 'upstream');
    box.git('config', '--add', 'repown.allowOwner', 'Octo-Org');
    assert.deepEqual((await read()).destination, { remote: 'upstream', owner: 'octo-org', allowed: ['octo-org'] });
  });

  test('diverged from the tracked ref on the destination', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', bare('origin'));
    box.git('push', '-q', '-u', 'origin', 'main');
    commit('mine');
    box.git('update-ref', 'refs/remotes/origin/main', box.git('commit-tree', 'HEAD~1^{tree}', '-p', 'HEAD~1', '-m', 'theirs'));
    assert.deepEqual((await read()).divergence, { ok: true, value: { tracked: 'origin/main', behind: 1, ahead: 1 } });
  });

  test('commits another remote has but the destination lacks (a fork)', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', bare('origin'));
    box.git('push', '-q', '-u', 'origin', 'main');
    box.git('remote', 'add', 'upstream', bare('upstream'));
    commit('from upstream', THEIRS);
    box.git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
    const facts = await read();
    assert.equal(facts.elsewhere.ok && facts.elsewhere.value.length, 1);
    assert.equal(facts.elsewhere.ok && facts.elsewhere.value[0]!.authorEmail, THEIRS);
  });

  test('no upstream: missing only where a plain git push would fail', async () => {
    commit('first');
    box.git('remote', 'add', 'origin', bare('origin'));
    assert.equal((await read()).upstream, 'missing');
    box.git('config', 'push.autoSetupRemote', 'true');
    assert.equal((await read()).upstream, null);
    box.git('config', '--unset', 'push.autoSetupRemote');
    box.git('config', 'push.default', 'current');
    assert.equal((await read()).upstream, null);
  });

  test('a detached HEAD', async () => {
    commit('first');
    box.git('checkout', '-q', '--detach');
    const facts = await read();
    assert.equal(facts.detached, true);
    assert.equal(facts.upstream, null);
  });
});
