// `repown status` says where the clone is and which settings are its own.
// S6 title, path and branch; S7 the two groups; S8 the recorded account;
// S9 what to run next; S10 outside a repository. The upstream field, the ready:
// summary (ADR-020) and the account line are in status-upstream, status-ready and
// status-account.test.ts, split off so node --test runs them in parallel.

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

describe('repown status layout', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S6: the title is on stdout', () => {
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, new RegExp('^' + TITLE + '$', 'm'));
    assert.doesNotMatch(run.stderr, /repown status ·/);
    assert.equal(repown([], box.dir).stdout, run.stdout);
  });

  // sandbox() is `git init -b main` with no commit: the branch exists, HEAD does not.
  // Git prints the work tree with forward slashes. Status shows native separators on Windows.
  test('S6: path and branch, including an unborn branch', () => {
    const root = box.git('rev-parse', '--show-toplevel');
    const shown = shownPath(root);
    const run = repown(['status'], box.dir);
    const title = run.stdout.indexOf(TITLE);
    const where = run.stdout.indexOf('  ' + shown + '  (branch main)');
    const clone = run.stdout.indexOf('This clone');
    assert.ok(title >= 0 && where > title && clone > where, run.stdout);
    if (process.platform === 'win32') assert.equal(shown.includes('\\'), true);
  });

  test('S6: a detached HEAD shows its short hash', () => {
    box.git('commit', '--allow-empty', '-m', 'base');
    box.git('checkout', '--detach');
    const hash = box.git('rev-parse', '--short', 'HEAD');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, new RegExp('\\(detached at ' + hash + '\\)'));
    assert.doesNotMatch(run.stdout, /\(branch /);
  });

  test('S7: This clone, then This machine, with their fields', () => {
    const run = repown(['status'], box.dir);
    assert.ok(run.stdout.indexOf('This clone') < run.stdout.indexOf('This machine'));
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'push guard']);
    assert.deepEqual(fieldsUnder(run.stdout, 'This machine'),
      ['default', 'helper', 'gh active']);
  });

  test('S7: existing values keep their wording', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /pushes as\s+octocat$/m);
    assert.match(run.stdout, /origin\s+octocat {2}\(GitHub\)/);
    assert.match(run.stdout, /push guard\s+off$/m);
    assert.match(run.stdout, /helper\s+manager$/m);
  });

  test('S7: default is the effective identity an unpinned clone inherits', () => {
    unpin(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Cat\n\temail = octocat@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /commits as\s+NOT SET LOCALLY/);
    assert.match(run.stdout, /default\s+Octo Cat <octocat@example\.invalid>/);
  });

  test('S7: an includeIf address is the default, and the FAIL quotes that same address', () => {
    unpin(box);
    const included = join(box.dir, '..', 'included-identity');
    writeFileSync(included, '[user]\n\temail = octo-work@example.invalid\n');
    box.writeGlobalConfig('[includeIf "gitdir:**"]\n\tpath = ' + included.replaceAll('\\', '/') + '\n');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /default\s+\? <octo-work@example\.invalid>/);
    assert.match(run.stderr, /inherits the machine default \(octo-work@example\.invalid\)/);
  });

  test('S7: a pinned clone shows an identity that lives only in the system file', () => {
    pinGithub(box);
    const system = process.env['GIT_CONFIG_SYSTEM'];
    assert.ok(system);
    writeFileSync(system, '[user]\n\tname = Octo Work\n\temail = octo-work@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /default\s+Octo Work <octo-work@example\.invalid>/);
  });

  test('S7: default stays the machine identity when this clone pins another', () => {
    pinGithub(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Work\n\temail = octo-work@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /default\s+Octo Work <octo-work@example\.invalid>/);
  });

  test('S7: default is none when neither name nor email is set', () => {
    unpin(box);
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /^ {2}default\s+none$/m);
  });
});

describe('gh warning account', () => {
  test('signed in to gh: the fix switches, in the spelling gh reports', () => {
    const advice = ghAdvice('octo-work', ghAccounts('octocat', ['octocat', 'octo-work']));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: gh auth switch -u octo-work');
  });

  test('signed in under a different case: the fix uses the login gh reports', () => {
    const advice = ghAdvice('Octo-Work', ghAccounts('octocat', ['octocat', 'octo-work']));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: gh auth switch -u octo-work');
  });

  test('not signed in to gh: the fix is repown use --gh', () => {
    const advice = ghAdvice('octo-work', ghActive('octocat'));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: repown use octo-work --gh   (signs octo-work in to gh)');
  });

  test('empty hosts is nobody signed in, not an unverified gh', () => {
    const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(ghAdvice('octocat', { ghPresent: true, gh: parsed }), null);
  });

  test('unverified gh stays a check of gh auth status', () => {
    const advice = ghAdvice('octocat', ghUnverified());
    assert.deepEqual(advice, {
      level: 'warn',
      text: 'could not be queried, so who `gh pr create` would act as is UNVERIFIED.',
      detail: 'check it yourself: gh auth status',
    });
  });
});

describe('repown status failure pointers', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S9: an unpinned clone\'s fix is setup, or use', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('FAIL  identity   This clone sets no identity of its own'), run.stderr);
    assert.ok(run.stderr.includes(SETUP_FIX), run.stderr);
  });

  test('S9: a clone with no push account has the same fix', () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    box.git('config', '--local', 'user.name', 'Octo Cat');
    box.git('config', '--local', 'user.email', 'octocat@example.invalid');
    box.git('config', '--local', 'credential.helper', 'manager');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('FAIL  identity   No account is pinned'), run.stderr);
    assert.ok(run.stderr.includes(SETUP_FIX), run.stderr);
    assert.equal(closing(run.stderr), '1 problem: run repown setup');
  });

  test('S9: gh as the helper still says repown fix, with no setup pointer', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('gh is the git credential helper'), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown fix'), run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(closing(run.stderr), '1 problem');
  });

  test('S9: unpinned with the guard off counts one problem and one warning', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), '1 problem, 1 warning: run repown setup');
  });

  test('S9: two warnings pluralise, and an identity problem still points at setup', () => {
    unpin(box);
    writeFileSync(join(box.dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octocat/lib.git\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 2, run.stderr);
    assert.equal(closing(run.stderr), '1 problem, 2 warnings: run repown setup');
  });

  test('S9: two problems pluralise, and the identity one still points at setup', () => {
    unpin(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 2, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(closing(run.stderr), '2 problems: run repown setup');
  });

  test('S9: warnings alone do not point at setup', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.equal(counted(run.stderr, 'FAIL'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
  });

  test('S9: a clean run still says ready, on stderr', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat');
    assert.doesNotMatch(run.stdout, /ready:/);
  });

  test('S9: a foreign pre-push hook is counted in the closing tally', () => {
    pinGithub(box);
    const hooks = join(box.dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /a pre-push hook repown did not write/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: core.hooksPath redirected is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'husky'));
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /core\.hooksPath/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: no credential helper on a pinned GitHub clone is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', '--unset', 'credential.helper');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /no credential helper is set/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: a non-GCM helper is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', 'store');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /"store" serves credentials here/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });
});

describe('repown status outside a repository', () => {
  test('S10: the failure is unchanged and no title is printed', () => {
    // realpath: macOS's tmpdir is /var, a link to /private/var, and the child's cwd is the real path.
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'repown-not-a-repo-')));
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = join(empty, '..');
    try {
      const run = repown(['status'], empty);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, notARepo(empty));
    } finally {
      restoreCeiling(saved);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
