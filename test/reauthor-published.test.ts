// repown reauthor and what the destination has published beyond its tracking refs (#9):
// a branch the fetch refspec leaves out, a pushed tag, a push that goes elsewhere.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { CLI, OURS, THEIRS } from './reauthor-helpers.ts';

describe('repown reauthor, what the destination already has (#9)', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const repown = (args: readonly string[]) => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: box.dir, input: '', env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  };
  const commit = (message: string, email: string): string => {
    box.git('-c', 'user.name=Someone', '-c', 'user.email=' + email, 'commit', '-q', '--allow-empty', '-m', message);
    return box.git('rev-parse', 'HEAD');
  };
  const origin = (): string => join(box.dir, '..', 'remote.git');
  const onOrigin = (...args: string[]): string => box.git('--git-dir=' + origin(), ...args);
  const pin = (): void => {
    const run = repown(['use', '--name', 'Octo Cat', '--email', OURS, 'octocat']);
    assert.equal(run.status, 0, run.stderr);
  };
  const authorOf = (rev: string): string => box.git('log', '-1', '--format=%ae', rev);

  /** main published (fetched), then a clone that fetches main only. */
  const singleBranch = (): void => {
    commit('published', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    box.git('fetch', '-q', 'origin');
  };

  /** A commit only origin has, on `ref`: this clone never saw it. */
  const remoteOnly = (ref: string): string => {
    const tree = onOrigin('mktree');
    const made = spawnSync('git', ['--git-dir=' + origin(), '-c', 'user.name=X', '-c', 'user.email=x@example.invalid',
      'commit-tree', tree, '-p', onOrigin('rev-parse', 'main'), '-m', 'remote only'], { encoding: 'utf8', env: process.env });
    const sha = made.stdout.trim();
    onOrigin('update-ref', ref, sha);
    return sha;
  };

  test('a single-branch clone: the pushed feature branch is left alone, only what came after is rewritten', () => {
    singleBranch();
    box.git('switch', '-q', '-c', 'feature');
    const pushed = commit('pushed theirs', THEIRS);
    box.git('push', '-q', 'origin', 'feature');
    commit('local theirs', THEIRS);
    pin();
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /1 commit now by octocat@example\.invalid/);
    assert.equal(box.git('rev-parse', 'HEAD~1'), pushed, 'the published commit must not be rewritten');
    assert.equal(authorOf('HEAD'), OURS);
  });

  test('a branch origin has and this clone never fetched: refused, nothing rewritten', () => {
    singleBranch();
    remoteOnly('refs/heads/other');
    box.git('switch', '-q', '-c', 'feature');
    commit('local theirs', THEIRS);
    pin();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /origin has commits this clone has not fetched \(remote\.origin\.fetch leaves some of its branches out, or something was pushed since the fetch\), so repown can't tell which of these it already has; nothing rewritten/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  });

  test('a pushed annotated tag protects its commit and what is below it', () => {
    commit('published', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const tagged = commit('tagged theirs', THEIRS);
    box.git('-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'tag', '-a', '-m', 'release', 'v1', tagged);
    box.git('push', '-q', 'origin', 'v1');
    commit('later theirs', THEIRS);
    pin();
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(box.git('rev-parse', 'HEAD~1'), tagged, 'the tagged commit must not be rewritten');
    assert.equal(authorOf('HEAD'), OURS);
  });

  test('a tag on a commit this clone does not have is no refusal', () => {
    commit('published', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('config', 'remote.origin.tagOpt', '--no-tags');
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    remoteOnly('refs/tags/elsewhere');
    commit('local theirs', THEIRS);
    pin();
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(authorOf('HEAD'), OURS);
  });

  test('a push that pushInsteadOf sends elsewhere is refused: the fetch tells nothing about it', () => {
    commit('published', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    box.git('fetch', '-q', 'origin');
    box.git('config', 'url.https://example.invalid/fork.git.pushInsteadOf', origin());
    commit('local theirs', THEIRS);
    pin();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not push to a remote repown can fetch/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  });

  test('excluded commits go to git on stdin as ^<sha>, so a long list fits any command line', async () => {
    commit('one', OURS);
    const second = commit('two', THEIRS);
    commit('three', THEIRS);
    const git = new Git(box.dir);
    const found = await git.identitiesIn(['HEAD'], [second]);
    assert.ok(found.ok);
    assert.equal(found.value.length, 1);
    const counted = await git.countIn(['HEAD'], [second]);
    assert.deepEqual(counted, { ok: true, value: 1 });
  });
});
