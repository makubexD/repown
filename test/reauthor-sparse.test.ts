// repown reauthor in a sparse checkout: what sparse-checkout leaves out is no hidden change,
// a skip-worktree or assume-unchanged bit set by hand still is (ADR-026).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { CLI, OURS, THEIRS } from './reauthor-helpers.ts';

describe('repown reauthor in a sparse checkout', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const repown = (args: readonly string[]) => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: box.dir, input: '', env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf8' });
    return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
  };
  const change = (path: string, text: string, email: string): void => {
    mkdirSync(join(box.dir, path, '..'), { recursive: true });
    writeFileSync(join(box.dir, path), text);
    box.git('add', path);
    box.git('-c', 'user.name=Someone', '-c', 'user.email=' + email, 'commit', '-q', '-m', path + ' ' + text);
  };
  const origin = (): string => join(box.dir, '..', 'remote.git');

  /** One published commit, then local commits by both addresses touching files in and out of `keep/`. */
  const field = (): void => {
    change('keep/a.txt', 'one', OURS);
    change('out/b.txt', 'one', OURS);
    box.git('init', '-q', '--bare', origin());
    box.git('remote', 'add', 'origin', origin());
    box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    change('out/b.txt', 'two', THEIRS);
    change('keep/a.txt', 'two', THEIRS);
    change('out/b.txt', 'three', OURS);
    assert.equal(repown(['use', '--name', 'Octo Cat', '--email', OURS, 'octocat']).status, 0);
  };
  const refusedHidden = (): void => {
    const before = box.git('rev-parse', 'HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /skip-worktree/);
    assert.equal(box.git('rev-parse', 'HEAD'), before);
  };

  test('what sparse-checkout leaves out is rewritten safely: same trees, still left out, nothing dirty', () => {
    field();
    box.git('sparse-checkout', 'set', 'keep');
    assert.equal(existsSync(join(box.dir, 'out', 'b.txt')), false);
    const trees = box.git('log', '--format=%T', 'origin/main..HEAD');
    const run = repown(['reauthor', '--yes']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(box.git('log', '--format=%ae|%ce', 'origin/main..HEAD').split('\n'), Array(3).fill(OURS + '|' + OURS));
    assert.equal(box.git('log', '--format=%T', 'origin/main..HEAD'), trees, 'every commit keeps its tree');
    assert.equal(existsSync(join(box.dir, 'out', 'b.txt')), false, 'the left-out file is still not on disk');
    assert.match(box.git('ls-files', '-v', 'out/b.txt'), /^S /);
    assert.equal(box.git('status', '--porcelain', '--untracked-files=no'), '');
  });

  test('a left-out file that is on disk after all still refuses', () => {
    field();
    box.git('sparse-checkout', 'set', 'keep');
    mkdirSync(join(box.dir, 'out'), { recursive: true });
    writeFileSync(join(box.dir, 'out', 'b.txt'), 'edited by hand');
    refusedHidden();
  });

  test('assume-unchanged still refuses in a sparse checkout', () => {
    field();
    box.git('sparse-checkout', 'set', 'keep');
    box.git('update-index', '--assume-unchanged', 'keep/a.txt');
    refusedHidden();
  });

  test('without sparse checkout, a skip-worktree bit set by hand refuses even when the file is gone', () => {
    field();
    box.git('update-index', '--skip-worktree', 'out/b.txt');
    rmSync(join(box.dir, 'out', 'b.txt'));
    refusedHidden();
  });

  test('a hidden file outside the current folder counts', async () => {
    field();
    box.git('update-index', '--skip-worktree', 'out/b.txt');
    const hidden = await new Git(join(box.dir, 'keep')).hasTrackedChanges();
    assert.deepEqual(hidden, { ok: true, value: true });
  });
});
