// repown reauthor: what it refuses, and the backup ref (split from reauthor.test.ts).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { planReauthor, applyReauthor } from '../src/core/reauthor.ts';
import {
  CLI, OURS, THEIRS, FailingRebase,
} from './reauthor-helpers.ts';

describe('repown reauthor', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const repown = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: box.dir, input: '', env: { ...process.env, NO_COLOR: '1', ...env }, encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  };
  const commit = (message: string, email: string): string => {
    box.git('-c', 'user.name=Someone', '-c', 'user.email=' + email, 'commit', '-q', '--allow-empty', '-m', message);
    return box.git('rev-parse', 'HEAD');
  };
  const origin = (): string => join(box.dir, '..', 'remote.git');
  const pin = (): void => {
    const run = repown(['use', '--name', 'Octo Cat', '--email', OURS, 'octocat']);
    assert.equal(run.status, 0, run.stderr);
  };
  const authors = (range: string): string[] => box.git('log', '--format=%ae|%ce', range).split('\n').filter(Boolean);

  /** Two published commits (one by THEIRS), then own, foreign, own, foreign locally. */
  const field = (): { published: string; ownFirst: string } => {
    commit('published own', OURS);
    const published = commit('published theirs', THEIRS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const ownFirst = commit('local own', OURS);
    commit('local theirs', THEIRS);
    commit('local own again', OURS);
    commit('local theirs again', THEIRS);
    pin();
    return { published, ownFirst };
  };

  test('a destination with branches this clone does not track: refused, nothing rewritten', () => {
    field();
    box.git('--git-dir=' + origin(), 'symbolic-ref', 'HEAD', 'refs/heads/main');
    box.git('config', '--unset-all', 'remote.origin.fetch');
    box.git('update-ref', '-d', 'refs/remotes/origin/main');
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not track origin's branches/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  });

  test('refusals change nothing: detached, dirty, unpinned, overrides, a URL destination, a failed fetch', () => {
    field();
    const before = box.git('rev-parse', 'HEAD');
    const refused = (pattern: RegExp, env: NodeJS.ProcessEnv = {}): void => {
      const run = repown(['reauthor', '--yes'], env);
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, pattern);
      assert.equal(box.git('rev-parse', 'HEAD'), before);
      assert.equal(box.git('for-each-ref', 'refs/repown/'), '');
    };
    refused(/GIT_AUTHOR_EMAIL is set/, { GIT_AUTHOR_EMAIL: THEIRS });
    box.git('config', 'author.email', THEIRS);
    refused(/author\.email is set/);
    box.git('config', '--unset', 'author.email');
    writeFileSync(join(box.dir, 'tracked.txt'), 'x');
    box.git('add', 'tracked.txt');
    refused(/uncommitted changes/);
    box.git('rm', '-q', '--cached', 'tracked.txt');
    rmSync(join(box.dir, 'tracked.txt'));
    box.git('config', 'branch.main.remote', 'https://octocat:tok@github.com/octocat/hello.git');
    refused(/point the branch at a remote first/);
    box.git('config', '--unset', 'branch.main.remote');
    rmSync(origin(), { recursive: true, force: true });
    refused(/could not fetch origin.*nothing rewritten/s);
    box.git('checkout', '-q', '--detach');
    refused(/HEAD is detached/);
  });

  test('an unpinned clone is refused', () => {
    commit('theirs', THEIRS);
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not pinned/);
  });

  test('a merge in the range is refused: rebasing would flatten it', () => {
    commit('base', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    commit('local theirs', THEIRS);
    box.git('checkout', '-q', '-b', 'side', 'HEAD~1');
    commit('side', OURS);
    box.git('checkout', '-q', 'main');
    box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=' + OURS, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    pin();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /a merge/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  });

  test('the backup ref does not count in the history addresses scan and setup read', async () => {
    field();
    assert.equal(repown(['reauthor', '--yes']).status, 0);
    const counts = await new Git(box.dir).emailCounts();
    assert.equal(counts.ok && counts.value.has(THEIRS), true, 'published commits by THEIRS still count');
    box.git('push', '-q', 'origin', 'HEAD:main');
    box.git('fetch', '-q', 'origin');
    const after = await new Git(box.dir).emailCounts();
    assert.equal(after.ok && after.value.get(THEIRS), 2, 'the one published commit (author and committer), not the backup\'s');
  });
});
