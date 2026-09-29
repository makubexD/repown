// `repown reauthor`: rewrite only this branch's commits by another address that no remote has,
// after fetching the push destination, keeping a backup, and never pushing (ADR-026).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { planReauthor, applyReauthor } from '../src/core/reauthor.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const OURS = 'octocat@example.invalid';
const THEIRS = 'old@example.invalid';

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

  test('user hooks do not run on the rewritten commits', () => {
    field();
    const hooks = join(box.dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\necho hooked >> "$1"\n', { mode: 0o755 });
    assert.equal(repown(['reauthor', '--yes']).status, 0);
    assert.doesNotMatch(box.git('log', '--format=%B', 'origin/main..HEAD'), /hooked/);
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

/** A real rebase whose --exec fails on the first commit, as a failing amend would. */
class FailingRebase extends Git {
  override rebaseExec(base: string): ReturnType<Git['rebaseExec']> {
    return super.rebaseExec(base, 'false');
  }
}
