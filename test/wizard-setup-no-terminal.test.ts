// repown setup with no terminal: --no-input, refusals, what it writes (split from wizard-setup.test.ts).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { setupContext as context } from './setup-fixtures.ts';
import { ok, err } from '../src/core/result.ts';
import { wizard, BACK, CANCEL, type Answers, type Prompter, type Reply, type Review, type ReviewChoice, type StepConfirm } from '../src/wizard/engine.ts';
import { setupFlow, planCommands, formatCommand, gitStepOf, keptFlags, blockersOf, changesOf, briefOf, missingFlags, printable, NEW_ACCOUNT, DETECTED_PREFIX, accountOf, isNew, signedInLogins, type SetupContext, type Suggestion } from '../src/wizard/setup-flow.ts';
import { pinWrites } from '../src/core/identity.ts';
import { plainPrompter } from '../src/wizard/plain.ts';
import { reviewLines, reviewDefault } from '../src/wizard/review-text.ts';
import { gitSupportsAutoUpstream } from '../src/core/version.ts';
import { SETUP_NOTE } from '../src/commands/start.ts';
import { runSetup } from '../src/wizard/setup-run.ts';
import { cloneChangeLines, machineChangeLines, readCloneSnapshot, type CloneSnapshot } from '../src/wizard/setup-changes.ts';
import { readContext } from '../src/wizard/setup-context.ts';
import { Git } from '../src/core/git.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { inherit, handingOver } from '../src/core/exec.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import {
  CLI, scripted, answer, textOf, argvOf, onBranch, reviewNotes, commitAt, restoreEnv, plainChoice, stepOf, wording, shellSplit, home, record, repown, localConfig, hook, shot, sectionLines, expectedPin, ghAuth, WAIT_CHILD, plainLead, guarded, holdInherit, untilUp, releaseInherit, captureStep, type Entry, type Home,
} from './wizard-setup-helpers.ts';

describe('repown setup, without a terminal', () => {
  let at: Home;
  beforeEach(() => { at = home(); });
  afterEach(() => at.dispose());

  test('without --no-input it exits 2, names what it would need, and writes nothing', () => {
    const before = localConfig(at);
    const run = repown(['setup'], at.box.dir);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /needs a terminal/);
    assert.match(run.stderr, /--no-input/);
    assert.equal(localConfig(at), before);
  });

  test('outside a repository it says where to run it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'repown-outside-'));
    try {
      const run = repown(['setup', 'octocat', '--no-input'], outside);
      assert.equal(run.status, 1);
      assert.ok(run.stderr.includes('run it inside a clone: cd path/to/repo, then repown setup'), run.stderr);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('--no-input with everything given runs the commands, and only what was asked for', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const run = repown(['setup', 'octocat', '--no-input', '--guard'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(localConfig(at), /account = octocat/);
    assert.ok(existsSync(hook(at)));
    assert.match(run.stderr, /step 1 of 2: Pin this clone to octocat/);
    assert.match(run.stderr, /step 2 of 2: Turn on the push guard/);
    assert.match(run.stderr, /done: this clone is set up for octocat$/m);
    assert.match(run.stderr, /check it any time: repown status \(this clone\), repown doctor \(this machine\)/);
    assert.doesNotMatch(run.stdout, /done:|check it any time/, 'setup\'s own lines stay off stdout');
    assert.match(run.stderr, /\n\n {7}step 2 of 2/, 'a blank line between steps');
    assert.doesNotMatch(run.stdout, /Next: repown guard on/, 'use\'s hint is left out when the next step turns the guard on');
    assert.match(run.stdout, /OK +guard +on/);
  });

  test('--no-input without --guard leaves the guard off', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const run = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(run.status, 0);
    assert.equal(existsSync(hook(at)), false);
    assert.match(run.stdout, /Next: repown guard on/, 'with no guard step to follow, use\'s hint stays');
  });

  test('--no-input with a value missing exits 2 naming it, and writes nothing', () => {
    const run = repown(['setup', 'octo-work', '--no-input'], at.box.dir);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--name/);
    assert.match(run.stderr, /--email/);
    assert.doesNotMatch(localConfig(at), /repown/);
    assert.equal(existsSync(join(at.registry, 'accounts.json')), false);
  });

  test('a new account given in full is recorded, then pinned', () => {
    const run = repown(['setup', 'octo-work', '--name', 'Octo Work', '--email', 'work@example.invalid', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(readFileSync(join(at.registry, 'accounts.json'), 'utf8'), /work@example\.invalid/);
    assert.match(localConfig(at), /account = octo-work/);
  });

  test('--name or --email for an account already recorded is a usage error, not an overwrite', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const run = repown(['setup', 'octocat', '--name', 'Other', '--email', 'other@example.invalid', '--no-input'], at.box.dir);
    assert.equal(run.status, 2);
    assert.match(readFileSync(join(at.registry, 'accounts.json'), 'utf8'), /octocat@example\.invalid/);
  });

  test('a recorded entry missing its name or email counts as not recorded, so nothing runs half-way', () => {
    writeFileSync(join(at.registry, 'accounts.json'), JSON.stringify({ accounts: { octocat: { name: '', email: '' } } }));
    at.box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    const run = repown(['setup', 'octocat', '--allow-owner', 'octo-org', '--no-input'], at.box.dir);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--name/);
    assert.doesNotMatch(localConfig(at), /allowOwner/);
  });

  test('--name and --email without an account still describe a new one, and --no-input asks for the login', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const run = repown(['setup', '--name', 'Octo Work', '--email', 'work@example.invalid', '--no-input'], at.box.dir);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /<account>/);
  });

  test('--fix where gh is not the helper says there is nothing to undo', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const run = repown(['setup', 'octocat', '--fix', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /nothing to undo/);
  });

  test('--allow-owner writes the owner repo-locally, once, however often setup runs', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    at.box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    for (let run = 0; run < 2; run++) {
      assert.equal(repown(['setup', 'octocat', '--allow-owner', 'octo-org', '--no-input'], at.box.dir).status, 0);
    }
    assert.equal(at.box.git('config', '--local', '--get-all', 'repown.allowOwner'), 'octo-org');
    assert.doesNotMatch(readFileSync(at.box.globalConfig, 'utf8'), /allowOwner/);
  });

  test('--allow-owner naming someone other than origin\'s owner is a usage error', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    at.box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    assert.equal(repown(['setup', 'octocat', '--allow-owner', 'someone-else', '--no-input'], at.box.dir).status, 2);
  });

  test('--guard with a hook repown did not write fails before writing anything', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    mkdirSync(join(at.box.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook(at), '#!/bin/sh\nexit 0\n');
    const run = repown(['setup', 'octocat', '--guard', '--no-input'], at.box.dir);
    assert.equal(run.status, 1);
    assert.doesNotMatch(localConfig(at), /repown/);
    assert.equal(readFileSync(hook(at), 'utf8'), '#!/bin/sh\nexit 0\n');
  });

  test('outside a repository it fails with exit 1', () => {
    const outside = mkdtempSync(join(tmpdir(), 'repown-norepo-'));
    try {
      assert.equal(repown(['setup', 'octocat', '--no-input'], outside).status, 1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('--help prints help and runs nothing', () => {
    const run = repown(['setup', '--help'], at.box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /--no-input/);
    assert.match(run.stdout, /--auto-upstream/);
    assert.match(run.stdout, /push branches without -u: the first push sets the upstream, in this clone only \(push\.autoSetupRemote\)/);
    assert.match(run.stdout, /--step-by-step/);
    assert.doesNotMatch(localConfig(at), /repown/);
  });

  test('S17 --step-by-step --no-input is a usage error and writes nothing', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const before = localConfig(at);
    const run = repown(['setup', 'octocat', '--step-by-step', '--no-input'], at.box.dir);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--step-by-step needs a terminal to ask/);
    assert.equal(localConfig(at), before);
  });

  test('S20 --auto-upstream answers yes in this clone; --no-input without it stays no', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    const supported = gitSupportsAutoUpstream(at.box.git('--version'));
    const skipped = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(skipped.status, 0, skipped.stderr);
    assert.throws(() => at.box.git('config', '--local', '--get', 'push.autoSetupRemote'));
    const run = repown(['setup', 'octocat', '--auto-upstream', '--guard', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    if (!supported) {
      assert.throws(() => at.box.git('config', '--local', '--get', 'push.autoSetupRemote'));
      return;
    }
    assert.equal(at.box.git('config', '--local', '--get', 'push.autoSetupRemote'), 'true');
    assert.doesNotMatch(readFileSync(at.box.globalConfig, 'utf8'), /autoSetupRemote/);
    const guardAt = run.stderr.indexOf('Turn on the push guard');
    const upAt = run.stderr.indexOf('Push branches without -u: the first push sets the upstream (this clone only)');
    assert.match(run.stdout, /upstream +branches without an upstream push without -u in this clone/);
    assert.ok(guardAt >= 0 && upAt > guardAt, run.stderr);
    assert.match(run.stderr, /git config --local push\.autoSetupRemote true/);
    assert.equal(repown(['setup', 'octocat', '--auto-upstream', '--no-input'], at.box.dir).status, 0);
    assert.equal(at.box.git('config', '--local', '--get', 'push.autoSetupRemote'), 'true');
  });

  test('S10 --auto-upstream writes nothing when push.autoSetupRemote is already effective', () => {
    record(at, 'octocat', 'octocat@example.invalid');
    at.box.git('config', '--global', 'push.autoSetupRemote', 'true');
    const run = repown(['setup', 'octocat', '--auto-upstream', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.throws(() => at.box.git('config', '--local', '--get', 'push.autoSetupRemote'));
    assert.match(readFileSync(at.box.globalConfig, 'utf8'), /autoSetupRemote/);
  });
});
