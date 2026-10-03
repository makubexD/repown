// S18: what setup says changed in this clone, and its report after a run (split from wizard-setup.test.ts).

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

describe('S18 diff of this clone', () => {
  test('names a changed key, an added key, a removed key, added allowOwner values, and the guard', () => {
    const before = shot(
      [['user.name', 'Sandbox'], ['user.email', 'sandbox@example.invalid'], ['user.useConfigOnly', null],
        ['repown.account', 'octocat'], ['credential.https://github.com.username', 'octocat']],
      ['kept-owner'], null, 'off');
    const after = shot(
      [['user.name', 'Octo Cat'], ['user.email', null], ['user.useConfigOnly', 'true'],
        ['repown.account', 'octocat'], ['credential.https://github.com.username', 'octo-work']],
      ['kept-owner', 'octo-org'], 'true', 'on');
    assert.deepEqual(cloneChangeLines(before, after), [
      '  user.name: Sandbox -> Octo Cat',
      '  user.email: sandbox@example.invalid -> (removed)',
      '  user.useConfigOnly: (added) true',
      '  credential.https://github.com.username: octocat -> octo-work',
      '  repown.allowOwner: (added) octo-org',
      '  push.autoSetupRemote: (added) true',
      '  push guard: off -> on',
    ]);
  });

  test('an unchanged clone, including allowOwner values in a different order, diffs to nothing', () => {
    const before = shot([['user.name', 'Octo Cat']], ['octo-org', 'octocat'], 'true', 'on');
    const after = shot([['user.name', 'Octo Cat']], ['octocat', 'octo-org'], 'true', 'on');
    assert.deepEqual(cloneChangeLines(before, after), []);
    assert.deepEqual(cloneChangeLines(before, shot([], [], 'true', 'on')), [
      '  user.name: Octo Cat -> (removed)',
      '  repown.allowOwner: octo-org, octocat -> (removed)',
    ]);
  });

  test('machine lines are the registry add and a gh account that is now active', () => {
    assert.deepEqual(machineChangeLines(null, null), []);
    assert.deepEqual(machineChangeLines('octo-work', 'octocat'), [
      "  this machine's account registry: added octo-work",
      "  gh: octocat is now gh's active account (every terminal)",
    ]);
  });

  test('the snapshot is local config, every allowOwner value, and the guard', async () => {
    const box = sandbox();
    try {
      box.git('config', '--local', '--unset', 'user.name');
      box.git('config', '--global', 'user.name', 'Octo Work');
      box.git('config', '--global', 'push.autoSetupRemote', 'true');
      box.git('config', '--local', '--add', 'repown.allowOwner', 'octo-org');
      box.git('config', '--local', '--add', 'repown.allowOwner', 'octocat');
      box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
      box.git('config', '--local', 'user.signingkey', 'not-watched');
      const shot = await readCloneSnapshot(new Git(box.dir), ['credential.https://github.com.username']);
      assert.deepEqual(shot.values.map(([key]) => key), [
        'user.name', 'user.email', 'user.useConfigOnly', 'repown.account',
        'credential.https://github.com.username',
      ]);
      assert.equal(shot.values[0]?.[1], null);
      assert.equal(shot.values[1]?.[1], 'sandbox@example.invalid');
      assert.equal(shot.values[4]?.[1], 'octocat');
      assert.equal(shot.autoUpstream, null);
      assert.deepEqual(shot.allowOwner, ['octo-org', 'octocat']);
      assert.equal(shot.guard, 'off');
      assert.equal(repown(['guard', 'on'], box.dir).status, 0);
      assert.equal((await readCloneSnapshot(new Git(box.dir), [])).guard, 'on');
    } finally {
      box.dispose();
    }
  });
});

describe('S18 after a setup run', () => {
  let at: Home;
  let savedPath: string | undefined;
  beforeEach(() => {
    at = home();
    record(at, 'octocat', 'octocat@example.invalid');
    at.box.git('config', '--local', 'push.autoSetupRemote', 'true');
    savedPath = process.env['PATH'];
    process.env['PATH'] = pathWithoutGh(savedPath ?? '');
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    at.dispose();
  });

  const play = (script: Entry[], prompter?: Prompter): Promise<{ code: number; stderr: string; stdout: string }> =>
    captureRun(script, prompter);

  test('Recommended lists every local change after done and before the check line', async () => {
    at.box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    at.box.git('config', '--local', 'credential.helper', '!echo live-password-should-not-appear');
    if (gitSupportsAutoUpstream(at.box.git('--version'))) at.box.git('config', '--local', '--unset', 'push.autoSetupRemote');
    const seen = await play([['mode', 'recommended'], ['account', 'octocat'], ['review', 'run']]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.deepEqual(sectionLines(seen.stderr, 'changed in this clone:', 'check it any time:'), expectedPin(at.box));
    assert.ok(seen.stderr.indexOf('done:') < seen.stderr.indexOf('changed in this clone:'));
    assert.match(seen.stderr, / {7}changed in this clone:/);
    assert.match(seen.stderr, / {9}user\.name: Sandbox -> Octo Cat/);
    assert.doesNotMatch(seen.stderr, /changed on this machine:/);
    assert.doesNotMatch(seen.stdout, /changed in this clone/);
    assert.doesNotMatch(seen.stdout + seen.stderr, /live-password/);
  });

  test('--allow-owner shows the added value, not the owners already there', () => {
    at.box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    at.box.git('config', '--local', '--add', 'repown.allowOwner', 'kept-owner');
    const run = repown(['setup', 'octocat', '--allow-owner', 'octo-org', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, / {9}repown\.allowOwner: \(added\) octo-org/);
    assert.doesNotMatch(run.stderr, /kept-owner/);
    assert.ok(run.stderr.indexOf('done:') < run.stderr.indexOf('changed in this clone:'));
    assert.ok(run.stderr.indexOf('changed in this clone:') < run.stderr.indexOf('check it any time:'));
  });

  test('a global identity is not reported as this clone\'s old value', () => {
    at.box.git('config', '--local', '--unset', 'user.name');
    at.box.git('config', '--local', '--unset', 'user.email');
    at.box.git('config', '--global', 'user.name', 'Octo Work');
    at.box.git('config', '--global', 'user.email', 'work@example.invalid');
    const run = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /user\.name: \(added\) Octo Cat/);
    assert.match(run.stderr, /user\.email: \(added\) octocat@example\.invalid/);
    assert.doesNotMatch(run.stderr, /Octo Work|work@example\.invalid ->/);
  });

  test('a global push.autoSetupRemote is not a change in this clone', () => {
    at.box.git('config', '--local', '--unset', 'push.autoSetupRemote');
    at.box.git('config', '--global', 'push.autoSetupRemote', 'true');
    const run = repown(['setup', 'octocat', '--auto-upstream', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /changed in this clone:/);
    assert.doesNotMatch(run.stderr, /push\.autoSetupRemote/);
  });

  test('skipping the pin still reports the guard, after the skipped line', async () => {
    const seen = await play([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'skip'], ['step', 'yes'],
    ]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.deepEqual(sectionLines(seen.stderr, 'changed in this clone:', 'check it any time:'), ['push guard: off -> on']);
    assert.ok(seen.stderr.indexOf('skipped:') < seen.stderr.indexOf('changed in this clone:'));
    assert.doesNotMatch(seen.stderr, /user\.name:/);
  });

  test('skipping every step says nothing changed', async () => {
    const seen = await play([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'skip'], ['step', 'skip'],
    ]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.match(seen.stderr, /nothing changed in this clone/);
    assert.doesNotMatch(seen.stderr, /changed in this clone:/);
    assert.ok(seen.stderr.indexOf('skipped:') < seen.stderr.indexOf('nothing changed in this clone'));
  });

  test('Stop before any step reports nothing changed, after the steps not run', async () => {
    const seen = await play([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'stop'],
    ]);
    assert.equal(seen.code, 130);
    assert.match(seen.stderr, /nothing changed in this clone/);
    assert.doesNotMatch(seen.stderr, /changed in this clone:|done:|check it any time/);
    assert.ok(seen.stderr.indexOf('not run:') < seen.stderr.indexOf('nothing changed in this clone'));
  });

  test('Stop after the pin reports what that step wrote and does not say done', async () => {
    const seen = await play([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'yes'], ['step', 'stop'],
    ]);
    assert.equal(seen.code, 130);
    assert.match(seen.stderr, /user\.name: Sandbox -> Octo Cat/);
    assert.doesNotMatch(seen.stderr, / {9}push guard:|done: this clone is set up|; the next push will fail/);
    assert.ok(seen.stderr.indexOf('not run:') < seen.stderr.indexOf('changed in this clone:'));
  });

  test('Apply the same settings again says nothing changed', async () => {
    const first = await play([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'run'], ['step', 'yes']]);
    assert.equal(first.code, 0, first.stderr);
    const again = await play([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'run'], ['step', 'yes']]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /done: this clone is set up for octocat$/m);
    assert.match(again.stderr, /nothing changed in this clone/);
    assert.doesNotMatch(again.stderr, /changed in this clone:/);
    assert.ok(again.stderr.indexOf('done:') < again.stderr.indexOf('nothing changed in this clone'));
    assert.ok(again.stderr.indexOf('nothing changed in this clone') < again.stderr.indexOf('check it any time:'));
  });

  test('Done, before any step, prints no change report', async () => {
    assert.equal((await play([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'run'], ['step', 'yes']])).code, 0);
    const done = await play([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'done']]);
    assert.equal(done.code, 0, done.stderr);
    assert.doesNotMatch(done.stderr, /changed in this clone:|nothing changed in this clone/);
  });

  test('a failed step still reports what earlier steps wrote', async () => {
    const base = scripted([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'yes'], ['step', 'yes'],
    ]);
    const prompter: Prompter = {
      ...base,
      confirmStep: async (brief) => {
        if (brief.command.includes('guard on')) at.box.git('config', 'core.hooksPath', join(at.box.dir, 'hooks-elsewhere'));
        return base.confirmStep(brief);
      },
    };
    const seen = await play([], prompter);
    assert.equal(seen.code, 1, seen.stderr);
    assert.match(seen.stderr, /stopped: that command exited 1/);
    assert.match(seen.stderr, /user\.name: Sandbox -> Octo Cat/);
    assert.doesNotMatch(seen.stderr, / {9}push guard:|done: this clone is set up|; the next push will fail|check it any time:/);
    assert.ok(seen.stderr.indexOf('exited 1') < seen.stderr.indexOf('changed in this clone:'));
  });

  test('a failed later step still names an account the registry step added', async () => {
    at.box.git('config', '--local', 'push.autoSetupRemote', 'true');
    const base = scripted([
      ['mode', 'step'], ['account', NEW_ACCOUNT], ['newAccount', 'octo-work'], ['host', 'github'],
      ['name', 'Octo Work'], ['email', 'work@example.invalid'], ['guard', false], ['reauthor', false], ['review', 'run'],
      ['step', 'yes'], ['step', 'yes'],
    ]);
    const prompter: Prompter = {
      ...base,
      confirmStep: async (brief) => {
        if (brief.command.includes('use ')) writeFileSync(join(at.registry, 'accounts.json'), '{');
        return base.confirmStep(brief);
      },
    };
    const seen = await play([], prompter);
    assert.equal(seen.code, 1, seen.stderr);
    assert.match(seen.stderr, /nothing changed in this clone/);
    assert.match(seen.stderr, /changed on this machine:\n\s+this machine's account registry: added octo-work/);
    assert.ok(seen.stderr.indexOf('nothing changed in this clone') < seen.stderr.indexOf('changed on this machine:'));
    assert.doesNotMatch(seen.stderr, /changed in this clone:/);
  });

  test("use --gh that leaves the account active is one machine line, not use's own sentence", async () => {
    const seen = await injected([['gh', true]], async () => ghAuth('Octocat', ['Octocat']));
    assert.equal(seen.code, 0, seen.stderr);
    assert.match(seen.stderr, /changed on this machine:\n\s+gh: octocat is now gh's active account \(every terminal\)/);
    assert.doesNotMatch(seen.stderr, /active account switched to|signed in as|optional, only if you use gh/);
    assert.ok(seen.stderr.indexOf('changed in this clone:') < seen.stderr.indexOf('changed on this machine:'));
    assert.ok(seen.stderr.indexOf("gh's active account") < seen.stderr.indexOf('check it any time:'));
  });

  test('use --gh that leaves someone else active does not claim the switch', async () => {
    const seen = await injected([['gh', true]], async () => ghAuth('octo-work', ['octo-work']));
    assert.equal(seen.code, 0, seen.stderr);
    assert.doesNotMatch(seen.stderr, /is now gh's active account|changed on this machine/);
    assert.match(seen.stderr, /optional, only if you use gh here/);
    assert.ok(seen.stderr.indexOf('changed in this clone:') < seen.stderr.indexOf('optional, only if you use gh here'));
  });

  test('gh already active is not reported when this run did not pass --gh', async () => {
    const seen = await injected([], async () => ghAuth('octocat', ['octocat']));
    assert.equal(seen.code, 0, seen.stderr);
    assert.match(seen.stderr, /changed in this clone:/);
    assert.doesNotMatch(seen.stderr, /is now gh's active account|changed on this machine|optional, only if you use gh/);
  });

  async function captureRun(script: Entry[], prompter?: Prompter): Promise<{ code: number; stderr: string; stdout: string }> {
    let stderr = '';
    let stdout = '';
    const errWrite = process.stderr.write;
    const outWrite = process.stdout.write;
    const take = (into: 'err' | 'out') => ((chunk: string | Uint8Array) => {
      if (into === 'err') stderr += String(chunk); else stdout += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.stderr.write = take('err');
    process.stdout.write = take('out');
    try {
      const code = await runSetup(
        { positional: [], flags: new Map([['cwd', at.box.dir]]) },
        { prompter: prompter ?? scripted(script), interactive: true },
      );
      return { code, stderr, stdout };
    } finally {
      process.stderr.write = errWrite;
      process.stdout.write = outWrite;
    }
  }

  function injected(
    extra: [string, string | boolean][],
    auth: () => Promise<AuthState>,
  ): Promise<{ code: number; stderr: string }> {
    return captureAuth(extra, auth);
  }

  async function captureAuth(extra: [string, string | boolean][], auth: () => Promise<AuthState>): Promise<{ code: number; stderr: string }> {
    let stderr = '';
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const flags = new Map<string, string | boolean>([['cwd', at.box.dir], ['no-input', true], ...extra]);
      const code = await runSetup({ positional: ['octocat'], flags }, { interactive: false, auth });
      return { code, stderr };
    } finally {
      process.stderr.write = write;
    }
  }
});
