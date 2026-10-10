// repown status: the upstream line (split from status.test.ts).

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

describe('repown status upstream', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S1: no upstream prints the push -u form, after origin, not as a warning', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'upstream', 'push guard']);
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.doesNotMatch(run.stderr, /upstream|none yet|push -u/);
  });

  test('S1: with no origin, the push -u form uses the first remote', () => {
    box.git('remote', 'add', 'work', 'https://github.com/octocat/project.git');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u work main'));
  });

  test('a remote named like an option is copied after --, as every printed command quotes it (ADR-025)', () => {
    box.git('config', 'remote.-x.url', 'https://github.com/octocat/project.git');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u "--" -x main'));
  });

  test('S1: origin wins over another remote in the push -u form', () => {
    box.git('remote', 'add', 'work', 'https://github.com/octocat/other.git');
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
  });

  test('S2: a tracked branch shows the ref git reports', () => {
    pinGithub(box);
    guardOn(box);
    track(box, 'origin/develop');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'origin/develop'));
  });

  test('S3: autoSetupRemote true locally, no upstream', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'true');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: autoSetupRemote true in global config, no upstream', () => {
    pinGithub(box);
    guardOn(box);
    box.writeGlobalConfig('[push]\n\tautoSetupRemote = true\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: a truthy non-true value still counts (push.autoSetupRemote)', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'yes');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: autoSetupRemote false still shows the push -u form', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'false');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
  });

  test('S4: a detached HEAD has no upstream field, even with a remote', () => {
    pinGithub(box);
    box.git('commit', '--allow-empty', '-m', 'base');
    box.git('checkout', '--detach');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stdout, /\(detached at /);
    assert.equal(upstreamLine(run.stdout), undefined);
  });

  test('S4: no remote means no upstream field', () => {
    const run = repown(['status'], box.dir, quietEnv());
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'push guard']);
    assert.equal(upstreamLine(run.stdout), undefined);
  });
});
