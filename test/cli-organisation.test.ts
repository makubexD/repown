// The real entry point: status in a clone pushing to an organisation (split from cli.test.ts).

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { compileFakeExe } from './fake-exe.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { runProgram, type DefaultChoice, type Loader, type Program } from '../src/ui/dispatch.ts';
import {
  CLI, repown, fakeProgram, FAKE_GH_CS, FAKE_GH_SH, ghEnv, recordOctocat, installFakeGh, capture, type Run,
} from './cli-helpers.ts';

describe('status in a clone pushing to an organisation', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('the organisation hint gives the exact repown.allowOwner command', () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /git config --local --add repown\.allowOwner octo-org/);
  });

  test('a hook repown did not write is reported with what to do about it', () => {
    mkdirSync(join(box.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(box.dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stdout, /push guard\s+foreign/);
    assert.match(run.stderr, /repown did not write/);
    assert.match(run.stderr, /delete .*pre-push, then run: repown guard on/);
  });

  test('with core.hooksPath redirecting hooks, it does not advise a `guard on` that would refuse', () => {
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'husky'));
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /core\.hooksPath/);
    assert.doesNotMatch(run.stderr, /Enable it: repown guard on/);
  });

  // ADR-009: where credentials are not pinned, `repown` says so rather than
  // implying otherwise.
  test('on a host whose credentials repown does not pin, it says so rather than "honours it"', () => {
    const azure = sandbox();
    try {
      azure.git('remote', 'add', 'origin', 'https://dev.azure.com/octo-org/p/_git/r');
      const run = repown([], { cwd: azure.dir });
      assert.match(run.stdout, /pushes as\s+not pinned by repown/);
      assert.doesNotMatch(run.stdout, /honours it/);
    } finally {
      azure.dispose();
    }
  });

  // "honours it" is a claim about the credential helper, so it is made only where
  // the helper is Git Credential Manager, the one measured to honour the pin.
  describe('the credential claim in a pinned GitHub clone', () => {
    const pinned = (helper: string | null): ReturnType<typeof repown> => {
      box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
      box.git('config', '--local', 'user.name', 'Octo Cat');
      box.git('config', '--local', 'user.email', 'octocat@users.noreply.github.com');
      box.git('config', '--local', 'repown.account', 'octocat');
      box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
      if (helper) box.git('config', '--local', 'credential.helper', helper);
      return repown([], { cwd: box.dir });
    };

    test('with Git Credential Manager as the helper, it says the pin is honoured', () => {
      assert.match(pinned('manager').stdout, /honours it/);
    });

    test('with no helper at all, it does not claim the pin is honoured, and says why', () => {
      const run = pinned(null);
      assert.doesNotMatch(run.stdout, /honours it/);
      assert.match(run.stderr, /no credential helper is set/);
    });

    test('with a helper repown has not measured, it says it cannot tell', () => {
      const run = pinned('store');
      assert.doesNotMatch(run.stdout, /honours it/);
      assert.match(run.stderr, /"store".*cannot tell whether it honours/);
    });
  });

  test('with no origin URL, it says there is no remote rather than naming an unknown host', () => {
    const bare = sandbox();
    try {
      bare.git('remote', 'add', 'origin', '');
      const run = repown([], { cwd: bare.dir });
      assert.match(run.stdout, /origin\s+no remote/);
      assert.match(run.stdout, /pushes as\s+no remote to push to/);
      assert.doesNotMatch(run.stdout, /this host/);
    } finally {
      bare.dispose();
    }
  });
});
