// repown setup's read of a clone: whether a pin is intact (split from wizard-setup.test.ts).

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

describe('setup context: would `use` change anything here?', () => {
  let at: Home;
  beforeEach(() => {
    at = home();
    record(at, 'octocat', 'octocat@example.invalid');
    at.box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
  });
  afterEach(() => at.dispose());

  const read = async (): Promise<SetupContext> => {
    const ctx = await readContext(new Git(at.box.dir), null);
    assert.ok(ctx.ok, ctx.ok ? '' : ctx.error);
    return ctx.value;
  };
  const pin = (): void => { assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0); };

  test('a clone `use` just pinned is intact, and one never pinned is not', async () => {
    assert.equal((await read()).pinIntact, false);
    pin();
    assert.equal((await read()).pinIntact, true);
  });

  test('the context keeps the credential keys and the hook path a step explains', async () => {
    const ctx = await read();
    assert.deepEqual(ctx.credentialKeys, ['credential.https://github.com.username']);
    assert.match(ctx.hookPath ?? '', /[\\/]pre-push$/);
  });

  test('any key `use` writes that differs, repeats, is blank or carries spaces is not intact', async () => {
    const edits: (readonly string[])[] = [
      ['config', 'user.email', 'other@example.invalid'],
      ['config', '--add', 'user.email', ''],
      ['config', '--add', 'repown.account', 'octocat'],
      ['config', 'user.email', ' octocat@example.invalid'],
      ['config', '--unset', 'credential.https://github.com.username'],
      ['config', '--unset', 'user.useConfigOnly'],
    ];
    for (const edit of edits) {
      pin();
      at.box.git(...edit);
      assert.equal((await read()).pinIntact, false, 'intact after: git ' + edit.join(' '));
      // `use` can't overwrite a key with two values: clear it before the next pin.
      const key = edit.find((word, index) => index > 0 && !word.startsWith('--'))!;
      try { at.box.git('config', '--unset-all', key); } catch { /* already unset */ }
    }
  });
});
