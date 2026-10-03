// repown reauthor: hooks, terminals, rebases in progress or failing, help (split from reauthor.test.ts).

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

  test('no hook runs during the rewrite: not commit-msg, prepare-commit-msg, post-commit or post-rewrite', () => {
    field();
    const hooks = join(box.dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const marker = join(box.dir, '..', 'hook-ran');
    for (const name of ['commit-msg', 'prepare-commit-msg']) writeFileSync(join(hooks, name), '#!/bin/sh\necho hooked >> "$1"\n', { mode: 0o755 });
    for (const name of ['post-commit', 'post-rewrite', 'pre-rebase']) writeFileSync(join(hooks, name), '#!/bin/sh\necho ' + name + ' >> "' + marker.replace(/\\/g, '/') + '"\n', { mode: 0o755 });
    assert.equal(repown(['reauthor', '--yes']).status, 0);
    assert.doesNotMatch(box.git('log', '--format=%B', 'origin/main..HEAD'), /hooked/);
    assert.equal(existsSync(marker), false, 'no post-commit, post-rewrite or pre-rebase hook ran');
  });

  test('without a terminal and without --yes it asks for --yes and changes nothing', () => {
    field();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /--yes/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  });

  test('a rebase in progress is refused and left alone', () => {
    field();
    const before = box.git('rev-parse', 'HEAD');
    mkdirSync(join(box.dir, '.git', 'rebase-merge'));
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /a rebase is in progress/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
    assert.equal(box.git('for-each-ref', 'refs/repown/'), '');
  });

  test('a rebase that fails is aborted: the branch is back where it was, the backup kept', async () => {
    field();
    const before = box.git('rev-parse', 'HEAD');
    const git = new FailingRebase(box.dir);
    const planned = await planReauthor(git, OURS, false);
    assert.ok(planned.ok && planned.value, 'there is something to rewrite');
    const done = await applyReauthor(git, planned.value, OURS);
    assert.equal(done.ok, false);
    assert.match(done.ok ? '' : done.error, /the rebase failed .*; nothing rewritten/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
    assert.equal(box.git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(await git.operationInProgress(), null);
    assert.match(box.git('for-each-ref', '--format=%(objectname)', 'refs/repown/backup/'), new RegExp('^' + before + '$'));
  });

  test('--help shows its options and rewrites nothing', () => {
    field();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--help']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /--yes/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
    assert.equal(box.git('rev-parse', 'origin/main'), box.git('rev-parse', 'HEAD~4'), 'nothing fetched or moved');
  });
});
