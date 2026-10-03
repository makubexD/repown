// repown setup's read of a clone and the machine: helpers, identity, versions, owners (split from wizard-setup.test.ts).

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

  test('says whether gh is the credential helper, anywhere in the helper list', async () => {
    assert.equal((await read()).ghIsHelper, false);
    at.box.git('config', 'credential.helper', '!gh auth git-credential');
    at.box.git('config', '--add', 'credential.helper', 'manager');
    assert.equal((await read()).ghIsHelper, true, 'gh asked first, even with another helper after it');
  });

  test('machine identity is global user.name and user.email, not the clone\'s', async () => {
    assert.deepEqual((await read()).machineIdentity, { name: null, email: null });
    at.box.git('config', '--global', 'user.name', 'Octo Cat');
    at.box.git('config', '--global', 'user.email', 'octocat@example.invalid');
    assert.deepEqual((await read()).machineIdentity, { name: 'Octo Cat', email: 'octocat@example.invalid' });
  });

  test('reads the git version gate and the effective push.autoSetupRemote', async () => {
    const ctx = await read();
    assert.equal(ctx.upstream.supported, gitSupportsAutoUpstream(at.box.git('--version')));
    assert.equal(ctx.upstream.enabled, null);
    assert.equal(ctx.upstream.branch, 'main');
    assert.equal(ctx.upstream.tracked, null);
    at.box.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    at.box.git('branch', '--set-upstream-to=origin/main');
    assert.equal((await read()).upstream.tracked, 'origin/main');
    at.box.git('config', '--global', 'push.autoSetupRemote', 'true');
    assert.equal((await read()).upstream.enabled, true, 'effective value, from any scope');
    at.box.git('config', '--local', 'push.autoSetupRemote', 'false');
    assert.equal((await read()).upstream.enabled, false, 'local false wins over global true');
    at.box.git('checkout', '--detach');
    assert.equal((await read()).upstream.branch, null);
    assert.equal((await read()).upstream.tracked, null);
  });

  test('an origin that is not GitHub detects no accounts and does not classify the owner', async () => {
    at.box.git('remote', 'set-url', 'origin', 'https://dev.azure.com/octo-org/project/_git/repo');
    const ctx = await read();
    assert.equal(ctx.owner, 'octo-org');
    assert.equal(ctx.detected.length, 0);
    assert.equal(ctx.ownerIsUser, null);
  });

  test('--no-input does not classify the owner', async () => {
    at.box.git('remote', 'set-url', 'origin', 'https://github.com/octo-org/project.git');
    let calls = 0;
    const accountKind = async (): Promise<'organization'> => { calls += 1; return 'organization'; };
    const ctx = await readContext(new Git(at.box.dir), null, { classifyOwner: false, accountKind });
    assert.ok(ctx.ok, ctx.ok ? '' : ctx.error);
    assert.equal(calls, 0);
    assert.equal(ctx.value.ownerIsUser, null);
    const status = await runSetup(
      { positional: ['octocat'], flags: new Map<string, string | boolean>([['no-input', true], ['cwd', at.box.dir]]) },
      { interactive: true, accountKind },
    );
    assert.equal(status, 0);
    assert.equal(calls, 0);
  });

  test('S19 readContext reads unpushed commits once, and the review compares the account email', async () => {
    const tree = at.box.git('rev-parse', 'HEAD^{tree}');
    const ours = commitAt(at.box, '1700000000', [
      '-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid',
      'commit-tree', tree, '-m', 'ours',
    ]);
    const foreign = commitAt(at.box, '1700000060', [
      '-c', 'user.name=Author', '-c', 'user.email=work@example.invalid',
      '-c', 'committer.name=Author', '-c', 'committer.email=work@example.invalid',
      'commit-tree', tree, '-p', ours, '-m', 'foreign',
    ]);
    at.box.git('update-ref', 'HEAD', foreign);
    writeFileSync(join(at.registry, 'accounts.json'), JSON.stringify({ accounts: {
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
      'octo-work': { name: 'Octo Work', email: 'work@example.invalid', host: 'github' },
    } }));
    const ctx = await read();
    assert.equal(ctx.unpushed.branch, 'main');
    assert.equal(ctx.unpushed.commits.ok, true);
    if (!ctx.unpushed.commits.ok) return;
    const emails = ctx.unpushed.commits.value.map((commit) => commit.authorEmail);
    assert.deepEqual(emails, ['work@example.invalid', 'octocat@example.invalid']);
    assert.match(reviewNotes(ctx, { account: 'octocat' }), /1 commit on main not on any remote is by work@example\.invalid/);
    const ownFirst = at.box.git('rev-parse', '--short', ours);
    assert.match(reviewNotes(ctx, { account: 'octocat' }), new RegExp('re-author it: git rebase ' + ownFirst + ' --exec "git commit --amend --no-edit --reset-author --allow-empty", or pin that address'));
    assert.match(reviewNotes(ctx, { account: 'octo-work' }), /1 commit on main not on any remote is by octocat@example\.invalid/);
    assert.match(reviewNotes(ctx, { account: 'octo-work' }), /re-author it: git rebase --root /);
    assert.doesNotMatch(reviewNotes(ctx, { account: 'octo-work' }), /work@example\.invalid/);
    at.box.git('update-ref', 'refs/remotes/origin/main', foreign);
    const published = await read();
    assert.equal(published.unpushed.commits.ok && published.unpushed.commits.value.length, 0);
    assert.doesNotMatch(reviewNotes(published, { account: 'octocat' }), /not on any remote/);
    at.box.git('checkout', '--detach');
    const detached = await read();
    assert.equal(detached.unpushed.branch, null);
  });

  test('what git actually uses must agree: an include or a differently-cased credential entry is not intact', async () => {
    pin();
    const extra = join(at.registry, 'extra.gitconfig');
    writeFileSync(extra, '[user]\n\temail = other@example.invalid\n');
    at.box.git('config', 'include.path', extra);
    assert.equal((await read()).pinIntact, false, 'an included file overrides the email');
    at.box.git('config', '--unset', 'include.path');
    assert.equal((await read()).pinIntact, true);
    at.box.git('config', 'credential.https://GITHUB.COM.username', 'octo-work');
    assert.equal((await read()).pinIntact, false, 'git matches credential URLs without case');
  });
});
