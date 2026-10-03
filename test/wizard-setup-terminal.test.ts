// repown setup on a terminal, with scripted answers (split from wizard-setup.test.ts).

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

describe('repown setup, on a terminal (scripted)', () => {
  let at: Home;
  let savedPath: string | undefined;
  // These scripts are about the pin and the guard. A gh on PATH that is signed
  // in to nobody would insert the sign-in question; keep that off this path.
  beforeEach(() => {
    at = home();
    record(at, 'octocat', 'octocat@example.invalid');
    // These scripts are step by step, about the pin and the guard. On git 2.37+
    // an unset push.autoSetupRemote would be another question, so set it the
    // way a finished setup would. Recommended would fill that answer itself.
    at.box.git('config', '--local', 'push.autoSetupRemote', 'true');
    savedPath = process.env['PATH'];
    process.env['PATH'] = pathWithoutGh(savedPath ?? '');
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    at.dispose();
  });

  const runWith = (prompter: Prompter): Promise<number> =>
    runSetup({ positional: [], flags: new Map([['cwd', at.box.dir]]) }, { prompter, interactive: true });
  const run = (script: Entry[]): Promise<number> => runWith(scripted(script));

  async function runCaptured(script: Entry[]): Promise<{ code: number; stderr: string; confirms: StepConfirm[] }> {
    let stderr = '';
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    const prompter = scripted(script);
    try {
      return { code: await runWith(prompter), stderr, confirms: prompter.confirms };
    } finally {
      process.stderr.write = write;
    }
  }

  test('S15 setup <recorded account> asks nothing before the review', async () => {
    const supported = gitSupportsAutoUpstream(at.box.git('--version'));
    if (supported) at.box.git('config', '--local', '--unset', 'push.autoSetupRemote');
    const prompter = scripted([['review', 'decline']]);
    const code = await runSetup(
      { positional: ['octocat'], flags: new Map<string, string | boolean>([['cwd', at.box.dir]]) },
      { prompter, interactive: true },
    );
    assert.equal(code, 1);
    assert.deepEqual(prompter.asked, []);
    const commands = prompter.reviews[0]!.steps.map((step) => step.command).join('\n');
    assert.match(commands, /guard on/);
    if (supported) assert.match(commands, /push\.autoSetupRemote/);
    assert.equal(prompter.reviews[0]!.settled, false);
  });

  test('--step-by-step skips the mode question and asks the guard', async () => {
    const prompter = scripted([['account', 'octocat'], ['guard', false], ['review', 'decline']]);
    const code = await runSetup(
      { positional: [], flags: new Map<string, string | boolean>([['cwd', at.box.dir], ['step-by-step', true]]) },
      { prompter, interactive: true },
    );
    assert.equal(code, 1);
    assert.deepEqual(prompter.asked, ['account', 'guard']);
  });

  test('Run pins the clone and turns the guard on', async () => {
    assert.equal(await run([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'], ['step', 'yes'], ['step', 'yes'],
    ]), 0);
    assert.match(localConfig(at), /account = octocat/);
    assert.ok(existsSync(hook(at)));
  });

  test('Done on the opening settled screen leaves git config byte-identical', async () => {
    assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0);
    assert.equal(repown(['guard', 'on'], at.box.dir).status, 0);
    const before = at.box.git('config', '--local', '--list');
    const prompter = scripted([['review', 'done']]);
    const endings: string[] = [];
    const closing: Prompter = { ...prompter, outro: (message) => { endings.push(message); } };
    assert.equal(await runWith(closing), 0);
    assert.deepEqual(prompter.asked, []);
    assert.equal(prompter.reviews[0]?.settled, true);
    assert.match(prompter.reviews[0]?.headline.join('\n') ?? '', /upstream {4}set on the first push \(push\.autoSetupRemote\)/);
    assert.equal(at.box.git('config', '--local', '--list'), before);
    assert.deepEqual(endings, ['Nothing changed: this clone was already set up']);
  });

  test('--no-input on a settled clone leaves git config byte-identical and can still name gh', () => {
    assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0);
    assert.equal(repown(['guard', 'on'], at.box.dir).status, 0);
    const before = at.box.git('config', '--local', '--list');
    const run = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(at.box.git('config', '--local', '--list'), before);
    assert.match(run.stderr, /done: this clone is set up for octocat$/m);
    assert.match(run.stderr, /nothing changed in this clone/);
    assert.doesNotMatch(run.stderr, /repown use /);
  });

  test('already set up: Done exits 0 and writes nothing; Apply again pins as before', async () => {
    const first = scripted([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'run'], ['step', 'yes']]);
    assert.equal(await runWith(first), 0);
    assert.equal(first.reviews[0]!.settled, false, 'not set up before the first run');
    const before = localConfig(at);
    const again = scripted([['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'done']]);
    assert.equal(await runWith(again), 0);
    assert.equal(again.reviews[0]!.settled, true, 'the clone, read back from git, counts as set up');
    assert.equal(localConfig(at), before);
    assert.equal(await run([
      ['mode', 'step'], ['account', 'octocat'], ['guard', false], ['review', 'run'], ['step', 'yes'],
    ]), 0);
    assert.equal(localConfig(at), before);
  });

  test('Decline exits 1 and writes nothing', async () => {
    const before = localConfig(at);
    assert.equal(await run([['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'decline']]), 1);
    assert.equal(localConfig(at), before);
    assert.equal(existsSync(hook(at)), false);
  });

  test('Decline and cancel each end with one line: nothing changed, and how to start again', async () => {
    const endings: [string, boolean | undefined][] = [];
    const closing = (script: Entry[]): Prompter => ({ ...scripted(script), outro: (message, cancelled) => { endings.push([message, cancelled]); } });
    assert.equal(await runWith(closing([['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'decline']])), 1);
    assert.equal(await runWith(closing([['mode', CANCEL]])), 130);
    assert.deepEqual(endings, [
      ['Declined: nothing was changed. Run repown setup again any time.', false],
      ['Cancelled: nothing was changed. Run repown setup again any time.', true],
    ]);
  });

  test('S16 Skip leaves that step unchanged and the next one still runs', async () => {
    const seen = await runCaptured([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'],
      ['step', 'skip'], ['step', 'yes'],
    ]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.doesNotMatch(localConfig(at), /account = octocat/);
    assert.ok(existsSync(hook(at)));
    assert.match(seen.stderr, /skipped: Pin this clone to octocat/);
    assert.doesNotMatch(seen.stderr, /done: this clone is set up|; the next push will fail/);
    assert.deepEqual(seen.confirms[0]?.changes, [
      'user.name = Octo Cat',
      'user.email = octocat@example.invalid',
      'user.useConfigOnly = true',
      'repown.account = octocat',
    ]);
    assert.equal(seen.confirms[0]?.initial, 'yes');
    assert.match(seen.confirms[0]?.command ?? '', /repown use octocat/);
    assert.match(seen.confirms[1]?.changes.join('\n') ?? '', /pre-push hook: .+pre-push runs repown guard check/);
    for (const line of seen.confirms.flatMap((item) => item.changes)) assert.doesNotMatch(line, /token|password|secret/i);
  });

  test('S16 done is said only when the pin ran', async () => {
    const seen = await runCaptured([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'],
      ['step', 'yes'], ['step', 'skip'],
    ]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.match(localConfig(at), /account = octocat/);
    assert.equal(existsSync(hook(at)), false);
    assert.match(seen.stderr, /done: this clone is set up for octocat$/m);
    assert.match(seen.stderr, /skipped: Turn on the push guard: each push is checked first/);
  });

  test('S16 skipping every step writes nothing and does not say the clone is set up', async () => {
    const seen = await runCaptured([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'],
      ['step', 'skip'], ['step', 'skip'],
    ]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.doesNotMatch(localConfig(at), /repown/);
    assert.equal(existsSync(hook(at)), false);
    assert.doesNotMatch(seen.stderr, /done: this clone is set up|; the next push will fail/);
    assert.match(seen.stderr, /skipped: Pin this clone to octocat/);
    assert.match(seen.stderr, /skipped: Turn on the push guard/);
  });

  test('S16 Stop and Esc run nothing further and list the steps not run', async () => {
    const stopped = await runCaptured([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'],
      ['step', 'stop'],
    ]);
    assert.equal(stopped.code, 130);
    assert.doesNotMatch(localConfig(at), /repown/);
    assert.equal(existsSync(hook(at)), false);
    assert.match(stopped.stderr, /stopped/);
    assert.doesNotMatch(stopped.stderr, /interrupted/);
    assert.match(stopped.stderr, /not run:/);
    assert.match(stopped.stderr, /repown use octocat/);
    assert.match(stopped.stderr, /repown guard on/);
    assert.doesNotMatch(stopped.stderr, /done: this clone is set up|; the next push will fail/);

    const cancelled = await runCaptured([
      ['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', 'run'],
      ['step', 'yes'], ['step', CANCEL],
    ]);
    assert.equal(cancelled.code, 130);
    assert.match(localConfig(at), /account = octocat/);
    assert.equal(existsSync(hook(at)), false);
    const rest = cancelled.stderr.split('not run:')[1] ?? '';
    assert.match(rest, /repown guard on/);
    assert.doesNotMatch(rest, /repown use/);
  });

  test('Recommended runs every planned step without asking again', async () => {
    const seen = await runCaptured([['mode', 'recommended'], ['account', 'octocat'], ['review', 'run']]);
    assert.equal(seen.code, 0, seen.stderr);
    assert.deepEqual(seen.confirms, []);
    assert.match(localConfig(at), /account = octocat/);
    assert.ok(existsSync(hook(at)));
    assert.match(seen.stderr, /\$ repown use octocat/);
    assert.match(seen.stderr, /done: this clone is set up for octocat$/m);
    assert.doesNotMatch(seen.stderr, /skipped:/);
  });

  test('Cancel at a step or at the review exits 130 and writes nothing', async () => {
    const before = localConfig(at);
    assert.equal(await run([['mode', CANCEL]]), 130);
    assert.equal(await run([['mode', 'step'], ['account', 'octocat'], ['guard', true], ['review', CANCEL]]), 130);
    assert.equal(localConfig(at), before);
  });

  test('a review that already named gh does not repeat it after the run', async () => {
    assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0);
    assert.equal(repown(['guard', 'on'], at.box.dir).status, 0);
    assert.equal(repown(['guard', 'off'], at.box.dir).status, 0);
    const preview = ghAuth('octo-work', ['octo-work']);
    const prompter = scripted([['mode', 'recommended'], ['account', 'octocat'], ['review', 'run']]);
    let stderr = '';
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const code = await runSetup(
        { positional: [], flags: new Map([['cwd', at.box.dir]]) },
        { prompter, interactive: true, auth: async () => preview, preview },
      );
      assert.equal(code, 0, stderr);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(prompter.asked, ['mode', 'account']);
    assert.match(prompter.reviews[0]?.notes.join('\n') ?? '', /If you use gh here: repown use octocat --gh \(signs octocat in to gh\)\./);
    assert.doesNotMatch(prompter.reviews[0]?.notes.join('\n') ?? '', /later: repown use|--gh {3}\(/);
    assert.doesNotMatch(stderr, /optional, only if you use gh/);
  });

  test('after the steps, gh advice is one more done line and the first push is not repeated', async () => {
    const left = await captureSetup(async () => ghAuth('octo-work', ['octo-work']));
    assert.equal(left.code, 0, left.stderr);
    assert.match(left.stderr, /done: this clone is set up for octocat$/m);
    assert.match(left.stderr, /optional, only if you use gh here: repown use octocat --gh {3}\(signs octocat in to gh\)/);
    assert.doesNotMatch(left.stderr, /first push/);
    const same = await captureSetup(async () => ghAuth('octocat', ['octocat']));
    assert.equal(same.code, 0, same.stderr);
    assert.doesNotMatch(same.stderr, /optional, only if you use gh here/);
  });

  function ghAuth(active: string, logins: readonly string[]): AuthState {
    return {
      gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
      gh: ok({ accounts: logins.map((login) => ({ login, active: login === active })), active }),
      helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
    };
  }

  async function captureSetup(auth: () => Promise<AuthState>): Promise<{ code: number; stderr: string }> {
    let stderr = '';
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
    try {
      const code = await runSetup(
        { positional: ['octocat'], flags: new Map<string, string | boolean>([['cwd', at.box.dir], ['no-input', true]]) },
        { interactive: false, auth },
      );
      return { code, stderr };
    } finally {
      process.stderr.write = write;
    }
  }
});
