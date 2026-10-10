// repown status: the ready line, and what will stop the next push (split from status.test.ts).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { ghAdvice } from '../src/commands/status.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { loadRegistry, registryPath } from '../src/core/registry.ts';
import { err, ok } from '../src/core/result.ts';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { compileFakeExe } from './fake-exe.ts';
import {
  CLI, TITLE, repown, SETUP_FIX, accountLine, upstreamLine, fieldLine, shownPath, GH_ACTIVE_NOTE, track, record, breakRegistry, fieldsUnder, pinGithub, unpin, quietEnv, fakeGhEnv, installFakeGh, FAKE_GH_CS, FAKE_GH_SH, guardOn, counted, tallyCount, assertRegistryWarning, ghActive, ghAccounts, ghUnverified, closing, notARepo, restoreCeiling, type Run,
} from './status-helpers.ts';

describe('repown status ready line', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S5: no problems, gh active as another account is a note after the identity line', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK {4}identity {3}this clone is pinned, and its credential mechanism honours it/);
    assert.ok(run.stderr.includes(GH_ACTIVE_NOTE), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown use octocat --gh   (signs octocat in to gh)'), run.stderr);
    assert.doesNotMatch(run.stderr, /WARN {2}gh/);
    assert.doesNotMatch(run.stdout, /NOTE {2}gh/);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 0, run.stderr);
    assert.ok(run.stderr.indexOf('NOTE  gh') < run.stderr.indexOf('ready:'), run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · gh: optional (see the note above)');
  });

  test('S5: the gh note is dim when stderr has colour, and plain when it does not', () => {
    pinGithub(box);
    guardOn(box);
    const plain = repown(['status'], box.dir, fakeGhEnv(box));
    assert.match(plain.stderr, /^NOTE  gh/m);
    assert.doesNotMatch(plain.stderr, /\x1b/);
    const coloured = repown(['status'], box.dir, fakeGhEnv(box, { FORCE_COLOR: '1' }));
    assert.match(coloured.stderr, /\x1b\[2mNOTE \x1b\[0m gh         active as "octo-work"/);
  });

  test('S5: no problems, only a gh could-not-be-queried warning', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box, { GH_FAKE_FAIL: '1' }));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}gh {9}could not be queried/);
    assert.doesNotMatch(run.stderr, /NOTE {2}gh/);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
  });

  test('S6: a non-gh warning is ready with the count, not tagged optional', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}guard/);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
    assert.doesNotMatch(run.stderr, /optional: gh/);
  });

  test('S6: a gh note mixed with a real warning is not part of the tally', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}guard/);
    assert.match(run.stderr, /NOTE {2}gh/);
    assert.ok(run.stderr.indexOf('WARN  guard') < run.stderr.indexOf('NOTE  gh'), run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
    assert.doesNotMatch(run.stderr, /gh: optional/);
  });

  test('S7: a problem does not count the gh note, and the note follows the failure', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /FAIL {2}identity/);
    assert.match(run.stderr, /NOTE {2}gh/);
    assert.doesNotMatch(run.stdout, /OK {4}identity/);
    assert.ok(run.stderr.indexOf('FAIL  identity') < run.stderr.indexOf('NOTE  gh'), run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(closing(run.stderr), '1 problem');
  });

  test('S7: a problem keeps today\'s tally and prints no ready line', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(closing(run.stderr), '1 problem, 1 warning: run repown setup');
    assert.doesNotMatch(run.stderr, /ready:/);
  });

  test('S7: gh as the helper still ends with 1 problem, no ready line', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(closing(run.stderr), '1 problem');
    assert.doesNotMatch(run.stderr, /ready:/);
  });

  test('the ready account matches the account field\'s spelling', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Cat', 'octocat@example.invalid');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded)');
    assert.equal(closing(run.stderr), 'ready: commits and pushes use Octocat');
  });

  test('a host with no credential pin does not claim the push identity', () => {
    box.git('remote', 'add', 'origin', 'https://dev.azure.com/octocat/project/_git/repo');
    box.git('config', '--local', 'user.name', 'Octo Cat');
    box.git('config', '--local', 'user.email', 'octocat@example.invalid');
    box.git('config', '--local', 'repown.account', 'octocat');
    guardOn(box);
    const clean = repown(['status'], box.dir, quietEnv());
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(closing(clean.stderr), 'ready: commits use octocat; pushes use this host\'s own sign-in');
    assert.doesNotMatch(clean.stderr, /commits and pushes use/);
    const warned = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(warned.status, 0, warned.stderr);
    assert.equal(counted(warned.stderr, 'WARN'), 0, warned.stderr);
    assert.match(warned.stderr, /NOTE {2}gh/);
    assert.equal(closing(warned.stderr),
      'ready: commits use octocat; pushes use this host\'s own sign-in · gh: optional (see the note above)');
    box.git('remote', 'set-url', 'origin', join(box.dir, 'elsewhere.git'));
    const local = repown(['status'], box.dir, quietEnv());
    assert.equal(local.status, 0, local.stderr);
    assert.equal(closing(local.stderr), 'ready: commits use octocat; pushes use this host\'s own sign-in');
  });
});

describe('repown status: what will stop the next push', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const theirs = (): void => {
    box.git('-c', 'user.name=Someone', '-c', 'user.email=old@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'theirs');
  };
  const warnings = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('WARN  '));

  test('commits by another address come first among the warnings, and there is no ready line', () => {
    pinGithub(box);
    guardOn(box);
    theirs();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(warnings(run.stderr)[0] ?? '', /^WARN\s+push\s+1 commit on main not on any remote is by old@example\.invalid/);
    assert.doesNotMatch(run.stderr, /ready:/);
    assert.equal(closing(run.stderr), 'the next push will fail: 1 commit by another address');
  });

  test('with the guard off, commits by another address are a warning and the clone is ready', () => {
    pinGithub(box);
    theirs();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(warnings(run.stderr)[0] ?? '', /^WARN\s+push\s+1 commit on main not on any remote is by old@example\.invalid; the guard is off, so it pushes as it is/);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 2 warnings');
  });

  test('a variable the guard refuses is named, with the others counted after the first', () => {
    pinGithub(box);
    guardOn(box);
    theirs();
    const run = repown(['status'], box.dir, { ...quietEnv(), GH_TOKEN: 'not-a-real-token' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN\s+push\s+GH_TOKEN is set in this shell/);
    assert.doesNotMatch(run.stderr, /not-a-real-token/);
    assert.equal(closing(run.stderr), 'the next push will fail: 1 commit by another address (and 1 more above)');
  });

  test('a push to another owner is said once, by the origin warning, and still is not ready', () => {
    pinGithub(box);
    guardOn(box);
    box.git('remote', 'set-url', 'origin', 'https://github.com/octo-org/project.git');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(warnings(run.stderr).filter((line) => line.includes('octo-org')).length, 1, run.stderr);
    assert.match(closing(run.stderr), /^the next push will fail: the push goes to "octo-org"/);
  });

  test('a push to another owner than origin\'s is said too, beside the origin warning', () => {
    pinGithub(box);
    guardOn(box);
    box.git('remote', 'set-url', 'origin', 'https://github.com/octo-org/project.git');
    box.git('remote', 'add', 'fork', 'https://github.com/octo-work/project.git');
    box.git('config', 'branch.main.pushRemote', 'fork');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN\s+origin\s+origin belongs to "octo-org"/);
    assert.match(run.stderr, /WARN\s+push\s+main pushes to fork, owned by "octo-work"/);
  });

  test('a missing upstream stays in its field, not a warning, and the clone is still ready', () => {
    pinGithub(box);
    guardOn(box);
    box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'mine');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.match(closing(run.stderr), /^ready: /);
  });
});
