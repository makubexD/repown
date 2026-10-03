// repown status: the account line (split from status.test.ts).

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

describe('repown status account', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S8: pinned, recorded, and this clone matches the record', () => {
    pinGithub(box);
    record(box, 'octocat', 'Octo Cat', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (recorded)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
    const coloured = repown(['status'], box.dir, { ...process.env, FORCE_COLOR: '1' });
    assert.match(coloured.stdout, /octocat {2}\x1b\[2m\(recorded\)\x1b\[0m/);
  });

  test('S8: the registry key\'s spelling is shown, and email matches ignoring case', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Cat', 'OctoCat@Example.Invalid');
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
  });

  test('S8: a different name warns, and the fix names the registry key', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Work', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded as Octo Work <octocat@example.invalid>)');
    const warn = 'this clone commits as Octo Cat <octocat@example.invalid>, but Octocat is recorded as Octo Work <octocat@example.invalid>.';
    assert.ok(run.stderr.includes('WARN  account    ' + warn), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown use Octocat'), run.stderr);
  });

  test('S8: a different email warns the same way', () => {
    pinGithub(box);
    record(box, 'octocat', 'Octo Cat', 'octo-work@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (recorded as Octo Cat <octo-work@example.invalid>)');
    const warn = 'this clone commits as Octo Cat <octocat@example.invalid>, but octocat is recorded as Octo Cat <octo-work@example.invalid>.';
    assert.ok(run.stderr.includes('WARN  account    ' + warn), run.stderr);
  });

  test('S8: pinned, but not in this machine\'s registry', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (not in this machine\'s registry)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
  });

  test('S8: the pin is repown.account, otherwise the credential username', () => {
    pinGithub(box);
    box.git('config', '--local', 'repown.account', 'octo-work');
    const owner = repown(['status'], box.dir);
    assert.equal(accountLine(owner.stdout), '  account        octo-work  (not in this machine\'s registry)');
    box.git('config', '--local', '--unset', 'repown.account');
    const credential = repown(['status'], box.dir);
    assert.equal(accountLine(credential.stdout), '  account        octocat  (not in this machine\'s registry)');
  });

  test('S8: not pinned lists registry keys in registry order', () => {
    record(box, 'octo-work', 'Octo Work', 'octo-work@example.invalid');
    record(box, 'octocat', 'Octo Cat', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        not pinned  (recorded: octo-work, octocat)');
  });

  test('S8: not pinned, and nothing recorded', () => {
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        not pinned  (none recorded)');
  });

  test('S8: an unreadable registry is reported and the exit code stays', async () => {
    pinGithub(box);
    breakRegistry();
    const loaded = await loadRegistry();
    const error = loaded.ok ? '' : loaded.error;
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.notEqual(error, '');
    assert.equal(accountLine(run.stdout), '  account        registry could not be read: ' + error);
    assert.doesNotMatch(run.stdout, /none recorded/);
    assertRegistryWarning(run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 2 warnings');
    assert.doesNotMatch(run.stderr, /run repown setup/);
  });

  test('S8: an unreadable registry never looks like none recorded', () => {
    breakRegistry();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.match(accountLine(run.stdout), /^ {2}account {8}registry could not be read: /);
    assert.doesNotMatch(run.stdout, /none recorded/);
    assertRegistryWarning(run.stderr);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });
});
