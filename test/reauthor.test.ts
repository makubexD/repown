// `repown reauthor`: rewrite only this branch's commits by another address that no remote has,
// after fetching the push destination, keeping a backup, and never pushing (ADR-026).

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

  test('fetches, rewrites only what the destination lacks from the oldest foreign commit, keeps a backup', () => {
    const { published, ownFirst } = field();
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(box.git('rev-parse', 'origin/main'), published, 'it fetched origin');
    assert.equal(box.git('rev-parse', 'HEAD~3'), ownFirst, 'own commits before the oldest foreign one are untouched');
    assert.deepEqual(authors('origin/main..HEAD'), Array(4).fill(OURS + '|' + OURS));
    assert.deepEqual(authors('origin/main'), [THEIRS + '|' + THEIRS, OURS + '|' + OURS], 'published history untouched');
    const backup = box.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/repown/backup/');
    assert.match(backup, new RegExp('^refs/repown/backup/main/\\d+ ' + before + '$'));
    assert.match(run.stdout + run.stderr, /OK\s+reauthor\s+3 commits now by octocat@example\.invalid/);
    assert.match(run.stdout + run.stderr, /undo: git reset --keep refs\/repown\/backup\/main\/\d+ \(drops commits made since\)/);
    assert.equal(box.git('merge-base', '--is-ancestor', 'origin/main', 'HEAD') === '', true, 'a fast-forward push');
  });

  test('the push afterwards passes the guard', () => {
    field();
    assert.equal(repown(['guard', 'on']).status, 0);
    assert.equal(repown(['reauthor', '--yes']).status, 0);
    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: box.dir, encoding: 'utf8', env: process.env });
    assert.equal(push.status, 0, push.stderr);
  });

  test('nothing by another address: nothing to do, exit 0, no backup', () => {
    commit('own', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    pin();
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout + run.stderr, /nothing to re-author/);
    assert.equal(box.git('for-each-ref', 'refs/repown/'), '');
  });

  test('an empty destination, proved empty: the root commit may be rewritten', () => {
    commit('first', THEIRS);
    commit('second', THEIRS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    pin();
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(authors('HEAD'), [OURS + '|' + OURS, OURS + '|' + OURS]);
  });
});

