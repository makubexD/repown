// `repown setup`: the flow (which steps, what they turn into) with a scripted
// prompter and a hand-built context, the setup lead, Ctrl-C during gh sign-in, and the
// repoint and re-author steps. The command run on a terminal, without one, its context
// read, S18 and repoint in a real clone are in the wizard-setup-*.test.ts files, split
// off so node --test runs them in parallel; a suite split by test keeps its name, so
// every test path is unchanged. Every run happens in a sandbox (isolated git config, registry).

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

describe('setup flow', () => {
  test('a recorded account in its own repo: pin it and turn the guard on', async () => {
    const ctx = context();
    const answers = await answer(ctx, [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    assert.deepEqual(argvOf(answers, ctx), [['use', '--', 'octocat'], ['guard', 'on']]);
  });

  test('a new account is recorded first, with host, name and email', async () => {
    const ctx = context({ owner: 'octo-work' });
    const answers = await answer(ctx, [
      ['account', NEW_ACCOUNT], ['newAccount', 'octo-work'], ['host', 'github'],
      ['name', 'Octo Work'], ['email', 'work@example.invalid'], ['guard', false], ['review', 'run'],
    ]);
    assert.deepEqual(argvOf(answers, ctx), [
      ['accounts', 'add', '--name=Octo Work', '--email=work@example.invalid', '--host=github', '--', 'octo-work'],
      ['use', '--', 'octo-work'],
    ]);
  });

  test('the same answers given as flags produce the same commands (parity)', async () => {
    const ctx = context({ owner: 'octo-work' });
    const given = { account: NEW_ACCOUNT, newAccount: 'octo-work', host: 'github', name: 'Octo Work', email: 'work@example.invalid', guard: false };
    const answers = await answer(ctx, [['review', 'run']], given);
    assert.deepEqual(argvOf(answers, ctx)[0], ['accounts', 'add', '--name=Octo Work', '--email=work@example.invalid', '--host=github', '--', 'octo-work']);
  });

  test('a new account name that is already recorded, in any case, is refused', async () => {
    const notes: string[] = [];
    const prompter = scripted([['account', NEW_ACCOUNT], ['newAccount', 'OctoCat'], ['newAccount', 'octo-work'],
      ['host', 'github'], ['name', 'x'], ['email', 'y'], ['allowOwner', false], ['guard', false], ['review', 'decline']]);
    await wizard(setupFlow(context()), context(), { mode: 'step' }, { ...prompter, note: (message) => notes.push(message) });
    assert.match(notes.join('\n'), /already recorded/);
  });

  test('an organisation origin asks to allow it, and the allowOwner line runs before use', async () => {
    const ctx = context({ owner: 'octo-org' });
    const answers = await answer(ctx, [['account', 'octocat'], ['allowOwner', true], ['guard', true], ['review', 'run']]);
    const commands = planCommands(answers, ctx);
    assert.deepEqual(commands.map((command) => command.argv), [
      ['git', 'config', '--local', '--add', 'repown.allowOwner', 'octo-org'], ['use', '--', 'octocat'], ['guard', 'on'],
    ]);
  });

  test('an owner already allowed, in any case, is not asked again', async () => {
    const ctx = context({ owner: 'Octo-Org', allowed: ['octo-org'] });
    await answer(ctx, [['account', 'octocat'], ['guard', true], ['review', 'run']]);
  });

  test('switching gh is offered on GitHub when gh knows the account and another is active', async () => {
    const gh = ok({ accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = context({ gh });
    const answers = await answer(ctx, [['account', 'octocat'], ['gh', true], ['guard', true], ['review', 'run']]);
    assert.deepEqual(argvOf(answers, ctx)[0], ['use', '--gh', '--', 'octocat']);
    const step = stepOf(ctx, 'gh');
    const picked = { account: 'octocat' };
    assert.equal(wording(step.message, picked, ctx), 'Also make this account gh\'s active account?');
    assert.match(wording(step.hint, picked, ctx), /git is not affected/);
    assert.equal((await step.detail?.(picked, ctx)), 'gh\'s active account is octo-work');
    const review = setupFlow(ctx).review({ account: 'octocat', gh: true, guard: true }, ctx);
    assert.ok(review.steps.some((item) => item.what === 'Pin this clone to octocat, and make it gh\'s active account'));
    await answer(context({ gh, host: 'azdo', credentialPinned: false }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    const active = ok({ accounts: [{ login: 'octocat', active: true }], active: 'octocat' });
    await answer(context({ gh: active }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
  });

  test('a GitHub account gh does not know is offered a sign-in, planning use --gh', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = context({ gh });
    const step = stepOf(ctx, 'gh');
    const picked = { account: 'octocat' };
    assert.equal(step.when?.(picked, ctx), true);
    assert.equal(step.initial?.(picked, ctx), false);
    assert.equal(wording(step.message, picked, ctx), 'Sign in to gh as octocat too?');
    assert.equal(wording(step.hint, picked, ctx),
      'gh is GitHub\'s command-line tool (gh pr create); git pushes don\'t need it. ' +
      'Yes opens your browser to sign in, and gh then acts as octocat in every terminal');
    assert.equal((await step.detail?.(picked, ctx)), 'gh\'s active account is octo-work');
    const answers = await answer(ctx, [['account', 'octocat'], ['gh', true], ['guard', false], ['review', 'run']]);
    assert.deepEqual(argvOf(answers, ctx), [['use', '--gh', '--', 'octocat']]);
    const review = setupFlow(ctx).review(answers, ctx);
    assert.ok(review.steps.some((item) => item.what === 'Pin this clone to octocat, and sign octocat in to gh (opens your browser)'));
    const given = await answer(ctx, [['guard', false], ['review', 'run']], { account: 'octocat', gh: true });
    assert.deepEqual(argvOf(given, ctx)[0], ['use', '--gh', '--', 'octocat']);
  });

  test('the gh sign-in is hidden when gh cannot be queried or the host is not GitHub', async () => {
    await answer(context({ gh: err('gh auth status failed') }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    const none = ok({ accounts: [], active: null });
    await answer(context({ gh: none, host: 'azdo', credentialPinned: false }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    const ctx = context({ gh: none });
    assert.equal((await stepOf(ctx, 'gh').detail?.({ account: 'octocat' }, ctx)), 'gh isn\'t signed in to any account');
    assert.equal(stepOf(ctx, 'gh').when?.({ account: 'octocat' }, ctx), true);
  });

  test('a fresh gh, from the empty hosts fixture, is offered a sign-in', async () => {
    const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const ctx = context({ gh: parsed });
    const step = stepOf(ctx, 'gh');
    const picked = { account: 'octocat' };
    assert.equal(step.when?.(picked, ctx), true);
    assert.equal(wording(step.message, picked, ctx), 'Sign in to gh as octocat too?');
    assert.equal((await step.detail?.(picked, ctx)), 'gh isn\'t signed in to any account');
  });

  test('when gh stays someone else, the review says so and names ghAdvice\'s fix', () => {
    const other = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const declined = setupFlow(context({ gh: other })).review({ account: 'octocat', gh: false, guard: false }, context({ gh: other }));
    assert.match(declined.notes.join('\n'), /gh still acts as octo-work, so gh pr create here would act as that account \(git pushes are unaffected\)\. If you use gh here: repown use octocat --gh \(signs octocat in to gh\)\./);
    assert.doesNotMatch(declined.notes.join('\n'), /later: repown use|--gh {3}\(/);
    const accepted = setupFlow(context({ gh: other })).review({ account: 'octocat', gh: true, guard: false }, context({ gh: other }));
    assert.equal(accepted.notes.some((line) => /gh still acts/.test(line)), false);
    const known = ok({ accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }], active: 'octo-work' });
    const switched = setupFlow(context({ gh: known })).review({ account: 'octocat', guard: true }, context({ gh: known }));
    assert.match(switched.notes.join('\n'), /If you use gh here: gh auth switch -u octocat\./);
    assert.doesNotMatch(switched.notes.join('\n'), /later: repown use|--gh {3}\(/);
    const elsewhere = context({ gh: other, host: 'azdo', credentialPinned: false });
    const hidden = setupFlow(elsewhere).review({ account: 'octocat', guard: false }, elsewhere);
    assert.match(hidden.notes.join('\n'), /gh still acts as octo-work/);
    const failed = setupFlow(context({ gh: err('gh auth status failed') })).review({ account: 'octocat', guard: false }, context({ gh: err('gh auth status failed') }));
    assert.equal(failed.notes.some((line) => /gh still acts|could not be queried/.test(line)), false);
    const settled = context({ gh: other, pinned: 'octocat', pinIntact: true, guard: 'on' });
    const quiet = setupFlow(settled).review({ account: 'octocat' }, settled);
    assert.equal(quiet.settled, true);
    assert.match(quiet.notes.join('\n'), /If you use gh here, choose "Sign in to gh as octocat" below\./);
    assert.doesNotMatch(quiet.notes.join('\n'), /later: repown use|--gh {3}\(/);
  });

  test('review names the gh command, and the settled screen points at its menu', () => {
    const other = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const signing = setupFlow(context({ gh: other, guard: 'on' })).review({ account: 'octocat' }, context({ gh: other, guard: 'on' }));
    assert.equal(signing.settled, false);
    assert.match(signing.notes.join('\n'), /If you use gh here: repown use octocat --gh \(signs octocat in to gh\)\./);
    assert.doesNotMatch(signing.notes.join('\n'), /later: repown use|--gh {3}\(/);
    const known = ok({ accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }], active: 'octo-work' });
    const switching = setupFlow(context({ gh: known, guard: 'on' })).review({ account: 'octocat' }, context({ gh: known, guard: 'on' }));
    assert.match(switching.notes.join('\n'), /If you use gh here: gh auth switch -u octocat\./);
    assert.doesNotMatch(switching.notes.join('\n'), /choose "|later: repown use/);
    const settled = context({ gh: other, pinned: 'octocat', pinIntact: true, guard: 'on' });
    const opened = setupFlow(settled).opening?.(settled) ?? null;
    assert.ok(opened);
    assert.equal(opened.ghSignIn, 'Sign in to gh as octocat');
    assert.match(opened.notes.join('\n'), /If you use gh here, choose "Sign in to gh as octocat" below\./);
    assert.doesNotMatch(opened.notes.join('\n'), /later: repown use|repown use octocat --gh/);
  });

  test('fix is offered only when gh is the helper, defaults to No, and runs before use', async () => {
    const ctx = context({ fixLines: ['    global:  credential.https://github.com.helper'] });
    const prompter = scripted([['account', 'octocat'], ['guard', true], ['fix', true], ['review', 'run']]);
    let initial: unknown;
    const outcome = await wizard(setupFlow(ctx), ctx, { mode: 'step' }, { ...prompter, ask: async (step, asked) => {
      if (step.id === 'fix') initial = asked.initial;
      return prompter.ask(step, asked);
    } });
    assert.equal(initial, false);
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.deepEqual(argvOf(outcome.answers, ctx), [['fix', '--yes'], ['use', '--', 'octocat'], ['guard', 'on']]);
  });

  test('no guard step when the hook is someone else\'s or core.hooksPath redirects it', async () => {
    await answer(context({ guard: 'foreign' }), [['account', 'octocat'], ['review', 'run']]);
    await answer(context({ redirected: true }), [['account', 'octocat'], ['review', 'run']]);
    await answer(context({ guard: 'on' }), [['account', 'octocat'], ['review', 'run']]);
  });

  test('the pinned account is the default, and --cwd reaches every clone command', async () => {
    const ctx = context({ pinned: 'octocat', cwd: '/work/project' });
    const prompter = scripted([['account', 'octocat'], ['guard', true], ['review', 'run']]);
    let initial: unknown;
    const outcome = await wizard(setupFlow(ctx), ctx, { mode: 'step' }, { ...prompter, ask: async (step, asked) => {
      if (step.id === 'account') initial = asked.initial;
      return prompter.ask(step, asked);
    } });
    assert.equal(initial, 'octocat');
    if (outcome.status !== 'run') return;
    assert.deepEqual(argvOf(outcome.answers, ctx), [['use', '--cwd=/work/project', '--', 'octocat'], ['guard', 'on', '--cwd=/work/project']]);
  });

  test('a value that starts with a dash stays attached to its option in the shown command', () => {
    assert.equal(formatCommand(['accounts', 'add', '--name=-dash', '--email=a@example.invalid', '--host=github', '--', 'octocat']),
      'repown accounts add octocat "--name=-dash" --email a@example.invalid');
  });

  test('every shown command parses back to the argv that runs', async () => {
    const { parseArgs } = await import('../src/ui/args.ts');
    const { specFor } = await import('../src/ui/command.ts');
    const commands: Record<string, () => Promise<import('../src/ui/command.ts').Command>> = {
      use: async () => (await import('../src/commands/use.ts')).default,
      'accounts add': async () => (await import('../src/commands/accounts.ts')).default.actions['add']!,
    };
    for (const [path, argv] of [['use', ['use', '--gh', '--', 'octocat']],
      ['accounts add', ['accounts', 'add', '--name=Octo Cat', '--email=a@example.invalid', '--host=azdo', '--', 'octo-work']]] as const) {
      const words = shellSplit(formatCommand(argv)).slice(1 + path.split(' ').length);
      const shown = parseArgs(words, specFor(await commands[path]!()));
      const run = parseArgs(argv.slice(path.split(' ').length), specFor(await commands[path]!()));
      assert.ok(shown.ok && run.ok);
      if (shown.ok && run.ok) assert.deepEqual(shown.value, run.value);
    }
  });

  test('the equivalent commands are shown quoted, the way you would type them', () => {
    assert.equal(formatCommand(['accounts', 'add', '--name=Octo Cat', '--email=a@example.invalid', '--host=github', '--', 'octocat']),
      'repown accounts add octocat --name "Octo Cat" --email a@example.invalid');
    assert.equal(formatCommand(['use', '--gh', '--', '-odd']), 'repown use --gh "--" -odd');
    assert.equal(formatCommand(['git', 'config', '--local', '--add', 'repown.allowOwner', 'octo-org']),
      'git config --local --add repown.allowOwner octo-org');
  });

  test('a recorded account with control characters is escaped in the account question', () => {
    const ctx = context({ recorded: { 'octo\x1bcat': { name: 'Octo\x1b[2JCat', email: 'o@example.invalid' } } });
    const choices = stepOf(ctx, 'account').choices?.({}, ctx) ?? [];
    for (const choice of choices) assert.doesNotMatch(choice.label + (choice.hint ?? ''), /[\x00-\x1f]/, JSON.stringify(choice));
  });

  test('control characters are shown escaped, so nothing can redraw the review', () => {
    const shown = formatCommand(['use', '--', 'octo\x1b[2Jcat']);
    assert.doesNotMatch(shown, /\x1b/);
    assert.equal(shown, 'repown use [value not safe to paste]', 'no quoting keeps a control character literal, so it is not offered to paste');
    const ctx = context({ owner: 'octo\x1b]0;x\x07org' });
    for (const line of textOf(setupFlow(ctx).review({ account: 'octocat', guard: true }, ctx))) {
      assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
    }
  });

  test('a new account login must be a plain name: no spaces, slashes, ? or #', () => {
    const newAccount = setupFlow(context()).steps.find((step) => step.id === 'newAccount')!;
    for (const bad of [' octo-work', 'octo work', 'octo/work', '../user', 'a?b', 'a#b', 'a\x1bb', '.', '..', '...']) {
      assert.ok(newAccount.validate?.(bad), bad);
    }
    for (const good of ['octo-work', 'octo.work', 'octo_work', 'octo@example.invalid']) {
      assert.equal(newAccount.validate?.(good), null, good);
    }
  });

  test('back and change an answer re-plan from the new answers', async () => {
    const ctx = context({ owner: 'octo-org' });
    const answers = await answer(ctx, [
      ['account', 'octocat'], ['allowOwner', true], ['guard', BACK], ['allowOwner', false], ['guard', false], ['review', 'run'],
    ]);
    assert.deepEqual(argvOf(answers, ctx), [['use', '--', 'octocat']]);
  });

  test('the review lists each command as a numbered plain step, the command under it', () => {
    const ctx = context({ owner: 'octo-org', recorded: {}, fixLines: ['  global  credential.helper = gh'] });
    const answers = { account: NEW_ACCOUNT, newAccount: 'octo-work', host: 'github', name: 'Octo Work', email: 'work@example.invalid',
      allowOwner: true, guard: true, fix: true };
    const review = setupFlow(ctx).review(answers, ctx);
    assert.equal(review.settled, false);
    assert.deepEqual(review.steps.map((step) => step.what.split(' ').slice(0, 3).join(' ')),
      ['Record the account', 'Let this clone', 'Stop gh answering', 'Pin this clone', 'Turn on the']);
    assert.deepEqual(review.steps.map((step) => step.command), planCommands(answers, ctx).map((command) => formatCommand(command.argv)));
    assert.deepEqual(review.steps[2]!.detail, ['  global  credential.helper = gh'], 'what fix removes, under its step');
  });

  test('ADR-026 what blocks the next push comes first among the notes', () => {
    const base = context({});
    const ctx = context({ push: { ...base.push, env: ['GH_TOKEN'] }, unpushed: onBranch(['old@example.invalid']) });
    const notes = setupFlow(ctx).review({ account: 'octocat' }, ctx).notes;
    assert.match(notes[0]!, /^1 commit on main not on any remote is by old@example\.invalid/);
    assert.ok(notes.some((line) => line.startsWith('GH_TOKEN is set in this shell')), notes.join('\n'));
  });

  test('ADR-026 a settled clone with a blocker is not "nothing needs to change"', () => {
    const base = context({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    const ctx = context({ pinned: 'octocat', pinIntact: true, guard: 'on', push: { ...base.push, env: ['GIT_AUTHOR_EMAIL'] } });
    const review = setupFlow(ctx).review({ account: 'octocat' }, ctx);
    assert.equal(review.settled, true);
    const text = reviewLines(review).join('\n');
    assert.doesNotMatch(text, /Nothing needs to change\./);
    assert.match(text, /Its settings need no change, but the next push will fail:/);
    assert.match(text, /GIT_AUTHOR_EMAIL is set in this shell/);
    const calm = setupFlow(base).review({ account: 'octocat' }, base);
    assert.match(reviewLines(calm).join('\n'), /Nothing needs to change\./);
  });

  test('WIZ-5 "or pin that address" only when there is one address to pin', () => {
    assert.match(reviewNotes(context({ unpushed: onBranch(['old@example.invalid']) })), /, or pin that address/);
    assert.doesNotMatch(reviewNotes(context({ unpushed: onBranch(['a@example.invalid', 'b@example.invalid']) })), /pin that address/);
  });

  test('a clone already pinned to that account, as recorded, is settled; anything left to do is not', () => {
    const settled = { pinned: 'octocat', pinIntact: true, guard: 'on' as const };
    const reviewOf = (overrides: Parameters<typeof context>[0], answers: Answers = { account: 'octocat' }): Review => {
      const ctx = context({ ...settled, ...overrides });
      return setupFlow(ctx).review(answers, ctx);
    };
    assert.equal(reviewOf({}).settled, true);
    assert.equal(reviewOf({ cwd: 'elsewhere' }).settled, true, '--cwd changes the argv, not the answer');
    assert.equal(reviewOf({ guard: 'off' }, { account: 'octocat', guard: false }).settled, true, 'the guard declined is still nothing to do');
    assert.equal(reviewOf({ pinIntact: false }).settled, false);
    assert.equal(reviewOf({ pinned: 'octo-work' }).settled, false);
    assert.equal(reviewOf({ ghIsHelper: true }).settled, false, 'use would warn the pin is not honoured');
    assert.equal(reviewOf({ owner: 'octo-org' }).settled, false, 'use would warn the guard refuses that owner');
    assert.equal(reviewOf({ owner: 'octo-org', allowed: ['octo-org'] }).settled, true);
    assert.equal(reviewOf({ guard: 'off' }, { account: 'octocat', guard: true }).settled, false);
    assert.equal(reviewOf({}, { account: 'octocat', gh: true }).settled, false);
    assert.equal(reviewOf({ upstream: { supported: true, enabled: null, branch: 'main', tracked: null } }).settled, true,
      'leaving the upstream question unanswered is still nothing this run must do');
    assert.match(reviewOf({ upstream: { supported: true, enabled: null, branch: 'main', tracked: null } }).notes.join('\n'),
      /optional: push branches without -u: repown setup --auto-upstream/);
    assert.equal(reviewOf({ upstream: { supported: true, enabled: false, branch: 'main', tracked: null } }).settled, true);
    assert.doesNotMatch(reviewOf({}).notes.join('\n'), /optional: push branches without -u/);
    assert.equal(reviewOf({ upstream: { supported: false, enabled: null, branch: 'main', tracked: null } }).settled, true,
      'old git is not offered the question');
    assert.match(reviewOf({}).title, /already set up/);
    assert.match(reviewOf({}).notes.join('\n'), /See it any time: repown status \(this clone\), repown doctor \(this machine\)/);
    assert.match(reviewOf({}).headline.join('\n'), /upstream {4}set on the first push \(push\.autoSetupRemote\)/);
    assert.doesNotMatch(reviewOf({ upstream: { supported: true, enabled: false, branch: 'main', tracked: null } }).headline.join('\n'), /upstream {4}/);
    assert.doesNotMatch(reviewOf({ upstream: { supported: true, enabled: null, branch: 'main', tracked: null } }).headline.join('\n'), /upstream {4}/);
    assert.equal(reviewOf({}).steps.length, 0, 'a settled plan does not re-pin');
    assert.equal(planCommands({ account: 'octocat' }, context(settled)).some((command) => command.argv[0] === 'use'), false);
  });

  test('the settled screen names the tracked ref, else the auto-setup wording, else nothing', () => {
    const settled = { pinned: 'octocat', pinIntact: true, guard: 'on' as const };
    const line = (upstream: SetupContext['upstream']): string => {
      const ctx = context({ ...settled, upstream });
      const review = setupFlow(ctx).review({ account: 'octocat' }, ctx);
      assert.equal(review.settled, true);
      return review.headline.join('\n');
    };
    const base = { supported: true, branch: 'main', enabled: true as boolean | null, tracked: null as string | null };
    assert.match(line({ ...base, tracked: 'origin/main' }), /^upstream {4}origin\/main$/m);
    assert.match(line({ ...base, tracked: null, enabled: true }), /^upstream {4}set on the first push \(push\.autoSetupRemote\)$/m);
    assert.doesNotMatch(line({ ...base, tracked: null, enabled: null }), /upstream {4}/);
    assert.doesNotMatch(line({ ...base, tracked: null, enabled: false }), /upstream {4}/);
  });

  test('a no-op pin is left out, and a drifted pin or a gh switch is kept', () => {
    const intact = context({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    assert.equal(planCommands({ account: 'octocat' }, intact).length, 0);
    assert.equal(planCommands({ account: 'octocat', gh: true }, intact)[0]?.argv.includes('--gh'), true);
    const drifted = context({ pinned: 'octocat', pinIntact: false, guard: 'on' });
    assert.equal(planCommands({ account: 'octocat' }, drifted)[0]?.argv[0], 'use');
    assert.match(setupFlow(drifted).review({ account: 'octocat' }, drifted).notes.join('\n'), /pinning again restores them/);
  });

  test('a review with no use step notes a missing stored credential, and stays quiet when use runs or the store lists it', () => {
    const upstream = { supported: true, enabled: null as boolean | null, branch: 'main', tracked: null };
    const base = { pinned: 'octocat', pinIntact: true, guard: 'on' as const, upstream };
    const missing = context({ ...base, stored: ok([]) });
    const review = setupFlow(missing).review({ account: 'octocat', mode: 'recommended', upstream: true }, missing);
    assert.equal(review.settled, false);
    assert.deepEqual(review.steps.map((step) => step.command), ['git config --local push.autoSetupRemote true']);
    assert.match(review.notes.join('\n'), /No stored credential for octocat yet: the first push signs in once \(your browser opens\)/);
    const listed = context({ ...base, stored: ok(['octocat']) });
    const quiet = setupFlow(listed).review({ account: 'octocat', mode: 'recommended', upstream: true }, listed);
    assert.doesNotMatch(quiet.notes.join('\n'), /No stored credential/);
    const pinning = context({ pinned: 'octocat', pinIntact: false, guard: 'on', stored: ok([]) });
    assert.doesNotMatch(setupFlow(pinning).review({ account: 'octocat' }, pinning).notes.join('\n'), /No stored credential/);
  });

  test('a settled clone opens on that screen before any question', async () => {
    const ctx = context({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    const done = scripted([['review', 'done']]);
    assert.deepEqual(await wizard(setupFlow(ctx), ctx, {}, done), { status: 'done' });
    assert.deepEqual(done.asked, []);
    assert.equal(done.reviews[0]?.settled, true);
    assert.match(done.reviews[0]?.headline.join('\n') ?? '', /upstream {4}set on the first push \(push\.autoSetupRemote\)/);
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const other = context({ gh, pinned: 'octocat', pinIntact: true, guard: 'on' });
    const signing = scripted([['review', 'gh'], ['review', 'decline']]);
    assert.deepEqual(await wizard(setupFlow(other), other, {}, signing), { status: 'declined' });
    assert.equal(signing.reviews[1]?.settled, false);
    assert.deepEqual(signing.reviews[1]?.steps.map((step) => step.command), ['repown use octocat --gh']);
    const back = scripted([['review', 'account'], ['account', BACK], ['review', 'done']]);
    assert.deepEqual(await wizard(setupFlow(ctx), ctx, {}, back), { status: 'done' });
    assert.deepEqual(back.asked, ['account']);
    assert.equal(back.reviews.length, 2);
  });

  test('Recommended answers No to gh when the clone is already pinned to that account; Step by step still asks', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = context({ gh, pinned: 'octocat', pinIntact: false, guard: 'on' });
    const recommended = scripted([['account', 'octocat'], ['review', 'run']]);
    const outcome = await wizard(setupFlow(ctx), ctx, { mode: 'recommended' }, recommended);
    assert.deepEqual(recommended.asked, ['account']);
    assert.match(recommended.reviews[0]?.notes.join('\n') ?? '', /If you use gh here: repown use octocat --gh \(signs octocat in to gh\)\./);
    assert.doesNotMatch(recommended.reviews[0]?.notes.join('\n') ?? '', /later: repown use|--gh {3}\(/);
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.equal(outcome.answers['gh'], undefined);
    assert.equal(argvOf(outcome.answers, ctx).some((argv) => argv.includes('--gh')), false);
    const stepped = scripted([['account', 'octocat'], ['gh', false], ['review', 'run']]);
    await wizard(setupFlow(ctx), ctx, { mode: 'step' }, stepped);
    assert.deepEqual(stepped.asked, ['account', 'gh']);
  });

  test('S8 asks to push branches without -u and plans the local git config after the guard', async () => {
    const upstream = { supported: true, enabled: null, branch: 'main', tracked: null };
    const ctx = context({ upstream });
    const step = stepOf(ctx, 'upstream');
    assert.equal(step.kind, 'confirm');
    assert.equal(step.flag, '--auto-upstream');
    assert.equal(wording(step.message, {}, ctx), 'Push branches without -u?');
    assert.match(wording(step.hint, {}, ctx), /sets push\.autoSetupRemote in this clone only/);
    assert.match(wording(step.hint, {}, ctx), /first push of a branch without an upstream creates it on origin/);
    assert.match(wording(step.hint, {}, ctx), /the guard still checks it/);
    assert.equal(await step.initial?.({}, ctx), true);
    assert.equal(step.when?.({}, ctx), true);
    const ids = setupFlow(ctx).steps.map((item) => item.id);
    assert.ok(ids.indexOf('guard') < ids.indexOf('upstream') && ids.indexOf('upstream') < ids.indexOf('fix'));
    const answers = await answer(ctx, [['account', 'octocat'], ['guard', true], ['upstream', true], ['review', 'run']]);
    const planned = planCommands(answers, ctx);
    assert.deepEqual(planned.map((command) => command.argv), [
      ['use', '--', 'octocat'], ['guard', 'on'],
      ['git', 'config', '--local', 'push.autoSetupRemote', 'true'],
    ]);
    assert.equal(planned.at(-1)!.what, 'Push branches without -u: the first push sets the upstream (this clone only)');
    assert.equal(formatCommand(planned.at(-1)!.argv), 'git config --local push.autoSetupRemote true');
    const elsewhere = context({ upstream, cwd: '/work/project', owner: 'octo-org' });
    const org = await answer(elsewhere, [
      ['account', 'octocat'], ['allowOwner', true], ['guard', true], ['upstream', true], ['review', 'run'],
    ]);
    assert.deepEqual(argvOf(org, elsewhere), [
      ['git', '-C', '/work/project', 'config', '--local', '--add', 'repown.allowOwner', 'octo-org'],
      ['use', '--cwd=/work/project', '--', 'octocat'],
      ['guard', 'on', '--cwd=/work/project'],
      ['git', '-C', '/work/project', 'config', '--local', 'push.autoSetupRemote', 'true'],
    ]);
  });

  test('S9 old or unreadable git skips the question and notes git push -u', async () => {
    for (const text of ['git version 2.36.99', 'git version 2.36.1.windows.1', '', 'not a version', 'git version']) {
      assert.equal(gitSupportsAutoUpstream(text), false, text);
    }
    for (const text of ['git version 2.37.0', 'git version 2.50.1.windows.1', 'git version 2.55.0.windows.5']) {
      assert.equal(gitSupportsAutoUpstream(text), true, text);
    }
    const feature = context({ upstream: { supported: false, enabled: null, branch: 'feature', tracked: null } });
    assert.equal(stepOf(feature, 'upstream').when?.({}, feature), false);
    const prompter = scripted([['account', 'octocat'], ['guard', true], ['review', 'decline']]);
    await wizard(setupFlow(feature), feature, { mode: 'step' }, prompter);
    assert.deepEqual(prompter.asked, ['account', 'guard']);
    const review = setupFlow(feature).review({ account: 'octocat', guard: true }, feature);
    assert.match(review.notes.join('\n'), /the first push of a branch without an upstream needs: git push -u origin feature/);
    const detached = context({
      pinned: 'octocat', pinIntact: true, guard: 'on',
      upstream: { supported: false, enabled: null, branch: null, tracked: null },
    });
    const quiet = setupFlow(detached).review({ account: 'octocat' }, detached);
    assert.equal(quiet.settled, true);
    assert.match(quiet.notes.join('\n'), /the first push of a branch without an upstream needs: git push -u origin <branch>/);
    const forced = planCommands({ account: 'octocat', upstream: true, guard: false }, feature);
    assert.ok(!forced.some((command) => command.argv.includes('push.autoSetupRemote')));
  });

  test('S11 the first question is how setup should work, and Recommended is the default', async () => {
    const ctx = context();
    assert.equal(setupFlow(ctx).steps[0]?.id, 'mode');
    const step = stepOf(ctx, 'mode');
    assert.equal(step.kind, 'select');
    assert.equal(step.flag, '--step-by-step');
    assert.equal(wording(step.message, {}, ctx), 'How should setup work?');
    assert.equal(await step.initial?.({}, ctx), 'recommended');
    const choices = step.choices?.({}, ctx) ?? [];
    assert.deepEqual(choices.map((choice) => [choice.value, choice.label]), [
      ['recommended', 'Recommended'], ['step', 'Step by step'],
    ]);
    assert.equal(choices[0]?.hint, 'asks only what it must, fills in the rest, and shows every step before running');
    assert.equal(choices[1]?.hint, 'asks every question, and explains each change before making it');
    const recommended = scripted([['mode', 'recommended'], ['account', 'octocat'], ['review', 'decline']]);
    await wizard(setupFlow(ctx), ctx, {}, recommended);
    assert.deepEqual(recommended.asked, ['mode', 'account']);
    const stepped = scripted([['account', 'octocat'], ['guard', true], ['review', 'decline']]);
    await wizard(setupFlow(ctx), ctx, { mode: 'step' }, stepped);
    assert.deepEqual(stepped.asked, ['account', 'guard'], 'a given mode is not asked');
  });

  test('S12 Recommended asks the account and a foreign owner; the filled steps show, and one can be changed', async () => {
    const gh = ok({
      accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }],
      active: 'octo-work',
    });
    const ctx = context({ gh, owner: 'octo-org', upstream: { supported: true, enabled: null, branch: 'main', tracked: null } });
    const prompter = scripted([
      ['mode', 'recommended'], ['account', 'octocat'], ['allowOwner', true], ['review', 'edit'],
      ['pick', 'guard'], ['guard', false], ['review', 'run'],
    ]);
    let offered: string[] = [];
    const outcome = await wizard(setupFlow(ctx), ctx, {}, {
      ...prompter,
      pickStep: async (steps) => { offered = steps.map((step) => step.id); return prompter.pickStep(steps); },
    });
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.deepEqual(prompter.asked, ['mode', 'account', 'allowOwner', 'guard']);
    assert.deepEqual(offered, ['mode', 'account', 'gh', 'allowOwner', 'guard', 'upstream']);
    const shown = prompter.reviews[0]!.steps.map((item) => item.command).join('\n');
    assert.match(shown, /repown\.allowOwner octo-org/);
    assert.match(shown, /repown use octocat --gh/);
    assert.match(shown, /repown guard on/);
    assert.match(shown, /push\.autoSetupRemote true/);
    assert.equal(outcome.answers['guard'], false);
    assert.equal(outcome.answers['gh'], true);
    assert.ok(!argvOf(outcome.answers, ctx).some((argv) => argv[0] === 'guard'));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv.includes('--gh')));
  });

  test('Recommended with a foreign owner asks to allow it, and No leaves it out of the plan', async () => {
    const ctx = context({ owner: 'octo-org', upstream: { supported: true, enabled: null, branch: 'main', tracked: null } });
    const picked = { account: 'octocat', mode: 'recommended' };
    const step = stepOf(ctx, 'allowOwner');
    assert.equal(step.auto, undefined);
    assert.equal(await step.initial?.(picked, ctx), true);
    assert.equal(wording(step.message, picked, ctx), 'This repository belongs to "octo-org". Let this clone push to it?');
    const prompter = scripted([
      ['mode', 'recommended'], ['account', 'octocat'], ['allowOwner', false], ['review', 'run'],
    ]);
    const outcome = await wizard(setupFlow(ctx), ctx, {}, prompter);
    assert.deepEqual(prompter.asked, ['mode', 'account', 'allowOwner']);
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.equal(outcome.answers['allowOwner'], false);
    assert.ok(!argvOf(outcome.answers, ctx).some((argv) => argv.includes('repown.allowOwner')));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv[0] === 'guard'));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv.includes('push.autoSetupRemote')));
  });

  test('S13 Recommended still asks to sign in to gh, and the default is No', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = context({ gh, upstream: { supported: true, enabled: null, branch: 'main', tracked: null } });
    const picked = { account: 'octocat', mode: 'recommended' };
    assert.equal(stepOf(ctx, 'gh').auto?.(picked, ctx), false);
    assert.equal(await stepOf(ctx, 'gh').initial?.(picked, ctx), false);
    let initial: unknown;
    const prompter = scripted([['mode', 'recommended'], ['account', 'octocat'], ['gh', false], ['review', 'run']]);
    const outcome = await wizard(setupFlow(ctx), ctx, {}, {
      ...prompter,
      ask: async (step, asked) => {
        if (step.id === 'gh') initial = asked.initial;
        return prompter.ask(step, asked);
      },
    });
    assert.equal(initial, false);
    assert.deepEqual(prompter.asked, ['mode', 'account', 'gh']);
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.ok(!argvOf(outcome.answers, ctx).some((argv) => argv.includes('--gh')));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv[0] === 'guard'));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv.includes('push.autoSetupRemote')));
  });

  test('S14 Recommended still asks fix, and the default is No', async () => {
    const ctx = context({ fixLines: ['    global:  credential.https://github.com.helper'] });
    let initial: unknown;
    const prompter = scripted([['mode', 'recommended'], ['account', 'octocat'], ['fix', false], ['review', 'run']]);
    const outcome = await wizard(setupFlow(ctx), ctx, {}, {
      ...prompter,
      ask: async (step, asked) => {
        if (step.id === 'fix') initial = asked.initial;
        return prompter.ask(step, asked);
      },
    });
    assert.equal(initial, false);
    assert.deepEqual(prompter.asked, ['mode', 'account', 'fix']);
    assert.equal(outcome.status, 'run');
    if (outcome.status !== 'run') return;
    assert.ok(!argvOf(outcome.answers, ctx).some((argv) => argv[0] === 'fix'));
    assert.ok(argvOf(outcome.answers, ctx).some((argv) => argv[0] === 'guard'));
  });

  test('S15 a recorded account given up front uses Recommended and still asks a foreign owner', async () => {
    const gh = ok({
      accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }],
      active: 'octo-work',
    });
    const ctx = context({
      gh, owner: 'octo-org', guard: 'off',
      upstream: { supported: true, enabled: null, branch: 'main', tracked: null },
    });
    const prompter = scripted([['allowOwner', true], ['review', 'decline']]);
    await wizard(setupFlow(ctx), ctx, { account: 'octocat', mode: 'recommended' }, prompter);
    assert.deepEqual(prompter.asked, ['allowOwner']);
    const commands = prompter.reviews[0]!.steps.map((item) => item.command).join('\n');
    assert.match(commands, /allowOwner/);
    assert.match(commands, /guard on/);
    assert.match(commands, /--gh/);
    assert.match(commands, /push\.autoSetupRemote/);
    assert.equal(prompter.reviews[0]!.settled, false);
  });

  test('an otherwise settled clone names --auto-upstream, unless Recommended will set it', async () => {
    const ctx = context({
      pinned: 'octocat', pinIntact: true, guard: 'on',
      upstream: { supported: true, enabled: null, branch: 'main', tracked: null },
    });
    const quiet = setupFlow(ctx).review({ account: 'octocat', upstream: false }, ctx);
    assert.equal(quiet.settled, true, 'No to upstream is still nothing this run must do');
    assert.match(quiet.notes.join('\n'), /optional: push branches without -u: repown setup --auto-upstream/);
    const already = context({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    const done = setupFlow(already).review({ account: 'octocat' }, already);
    assert.doesNotMatch(done.notes.join('\n'), /optional: push branches without -u/);
    const prompter = scripted([['review', 'decline']]);
    await wizard(setupFlow(ctx), ctx, { account: 'octocat', mode: 'recommended' }, prompter);
    assert.deepEqual(prompter.asked, []);
    assert.equal(prompter.reviews[0]!.settled, false);
    assert.ok(prompter.reviews[0]!.steps.some((item) => item.command.includes('push.autoSetupRemote')));
  });

  test('S10 an effective push.autoSetupRemote is not asked and not planned', async () => {
    const ctx = context({ upstream: { supported: true, enabled: true, branch: 'main', tracked: null } });
    assert.equal(stepOf(ctx, 'upstream').when?.({}, ctx), false);
    await answer(ctx, [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    const planned = planCommands({ account: 'octocat', guard: true, upstream: true }, ctx);
    assert.ok(!planned.some((command) => command.argv.includes('push.autoSetupRemote')));
    const off = context({ upstream: { supported: true, enabled: false, branch: 'main', tracked: null } });
    assert.equal(stepOf(off, 'upstream').when?.({}, off), true, 'an explicit false is not already on');
  });

  test('the guard question says when a repository has no commits yet', async () => {
    const guard = setupFlow(context()).steps.find((step) => step.id === 'guard')!;
    assert.match((await guard.detail!({ account: 'octocat' }, context())) ?? '', /no commits yet/);
  });

  test('a clone pinned to the account but changed since says why pinning again is offered', () => {
    const ctx = context({ pinned: 'octocat', pinIntact: false, guard: 'on' });
    const review = setupFlow(ctx).review({ account: 'octocat' }, ctx);
    assert.ok(review.notes.some((line) => /differ from what is recorded/.test(line)), review.notes.join('\n'));
  });

  test('values read from a clone are shown with invisible and control characters escaped', () => {
    for (const hidden of ['\u202e', '\u200b', '\u009b', '\x1b']) assert.doesNotMatch(printable('octo' + hidden + 'org'), /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\x1b]/);
  });

  test('every question carries a hint a newcomer can act on', () => {
    for (const step of setupFlow(context()).steps) {
      const hint = wording(step.hint, { account: 'octocat' }, context());
      assert.ok(hint.trim().length > 10, step.id + ' has no real hint');
    }
  });

  test('missing flags for --no-input are named', () => {
    const recorded = context().recorded;
    assert.deepEqual(missingFlags({}, recorded), ['<account>']);
    assert.deepEqual(missingFlags({ account: NEW_ACCOUNT, newAccount: 'octo-work' }, recorded), ['--name', '--email']);
    assert.deepEqual(missingFlags({ account: 'octocat' }, recorded), []);
  });

  test('where the host has no credential pin, the review says so rather than claiming one (ADR-009)', () => {
    const ctx = context({ host: 'azdo', credentialPinned: false });
    const review = setupFlow(ctx).review({ account: 'octocat', guard: false }, ctx);
    assert.ok(textOf(review).some((line) => /repown pins the sign-in on GitHub only/.test(line)), textOf(review).join('\n'));
    assert.ok(!textOf(review).some((line) => /push as octocat/.test(line)));
  });

  test('a history that could not be read is said, not shown as clean', async () => {
    const flow = setupFlow(context({ addresses: err('git log failed') }));
    const guard = flow.steps.find((step) => step.id === 'guard')!;
    assert.match((await guard.detail?.({ account: 'octocat' }, context({ addresses: err('git log failed') }))) ?? '', /could not be read/);
  });

  test('S19 the review notes unpushed commits by another address, and Recommended does not rewrite them', () => {
    const ctx = context({ guard: 'on', unpushed: onBranch(['old@example.invalid', 'also@example.invalid']) });
    const notes = reviewNotes(ctx);
    assert.match(notes, /2 commits on main not on any remote are by old@example\.invalid, also@example\.invalid; the guard will refuse them/);
    assert.match(notes, /re-author them: git rebase abc1234 --exec "git commit --amend --no-edit --reset-author --allow-empty"$/m);
    const planned = planCommands({ account: 'octocat', mode: 'recommended', guard: true }, ctx);
    assert.equal(planned.some((command) => command.argv.some((arg) => /rebase|amend|reset-author/.test(arg))), false);
    const settled = context({
      pinned: 'octocat', pinIntact: true, guard: 'on',
      unpushed: onBranch(['old@example.invalid']),
    });
    const again = setupFlow(settled).review({ account: 'octocat' }, settled);
    assert.equal(again.settled, true);
    assert.match(again.notes.join('\n'), /1 commit on main not on any remote is by old@example\.invalid; the guard will refuse it/);
    assert.match(again.notes.join('\n'), /re-author it: git rebase abc1234 --exec "git commit --amend --no-edit --reset-author --allow-empty", or pin that address/);
    const rooted = context({ unpushed: onBranch(['old@example.invalid'], '--root') });
    assert.match(reviewNotes(rooted), /re-author it: git rebase --root --exec "git commit --amend --no-edit --reset-author --allow-empty", or pin that address/);
  });

  test('S19 the same commit list is compared with the planned email', () => {
    const recorded = {
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
      'octo-work': { name: 'Octo Work', email: 'work@example.invalid', host: 'github' },
    };
    const ctx = context({ recorded, unpushed: onBranch(['work@example.invalid']) });
    assert.match(reviewNotes(ctx, { account: 'octocat' }), /1 commit on main not on any remote is by work@example\.invalid/);
    assert.doesNotMatch(reviewNotes(ctx, { account: 'octo-work' }), /not on any remote/);
    const fresh = context({ recorded: {}, unpushed: onBranch(['old@example.invalid']) });
    const answers = { account: NEW_ACCOUNT, newAccount: 'octocat', email: 'octocat@example.invalid' };
    assert.match(reviewNotes(fresh, answers), /old@example\.invalid/);
  });

  test('S19 a committer who is not the author counts, and case does not', () => {
    const mixed = context({ guard: 'on', unpushed: { branch: 'main', unknown: null, commits: ok([
      { authorEmail: 'octocat@example.invalid', committerEmail: 'Other@example.invalid', parent: 'fff0' },
      { authorEmail: 'other@example.invalid', committerEmail: 'octocat@example.invalid', parent: 'abc1234' },
    ]) } });
    assert.match(reviewNotes(mixed), /2 commits on main not on any remote are by Other@example\.invalid; the guard will refuse them/);
    const same = context({ unpushed: onBranch(['Octocat@example.invalid']) });
    assert.doesNotMatch(reviewNotes(same), /not on any remote/);
    const capped = context({ unpushed: onBranch([
      'a@example.invalid', 'b@example.invalid', 'c@example.invalid', 'd@example.invalid', 'e@example.invalid',
    ]) });
    assert.match(reviewNotes(capped), /5 commits on main not on any remote are by a@example\.invalid, b@example\.invalid, c@example\.invalid and 2 more/);
  });

  test('ADR-025 behind a remote with no tracking refs the review says to fetch, and the rebase is conditional', () => {
    const unknown = { kind: 'remote', name: 'my fork' } as const;
    const notes = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid'], '--root'), unknown } }));
    assert.match(notes, /my fork has no remote-tracking refs, so some of these may already be on it \(the guard skips any already on the branch you push to\): git fetch "my fork", then repown use octocat to count again/);
    assert.match(notes, /if my fork has none of them, re-author it: git rebase --root /);
    assert.doesNotMatch(notes, /^\s*re-author/m);
  });

  test('ADR-025 a name git would read as an option comes after --, and hidden text is shown', () => {
    const dashed = { kind: 'remote', name: '--upload-pack=touch x' } as const;
    const notes = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: dashed } }));
    assert.match(notes, /--upload-pack=touch x has no remote-tracking refs, so some of these may already be on it \(the guard skips any already on the branch you push to\)/);
    assert.match(notes, /git fetch "--" "--upload-pack=touch x", then/, 'git reads it as the remote, never as an option (ADR-026)');
    const url = { kind: 'url', key: 'branch.main.remote', remote: '-o' } as const;
    const repointed = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: url } }));
    assert.match(repointed, /git config --local branch\.main\.remote -o, git fetch "--" -o, then/);
    const bidi = { kind: 'remote', name: 'fork\u202egnp.exe\u200b' } as const;
    assert.match(reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: bidi } })), /git fetch "fork\?gnp\.exe\?"/);
  });

  test('ADR-025 remotes that could not be read are unknown, not "none"', () => {
    const notes = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: { kind: 'unread' } } }));
    assert.match(notes, /the remotes could not be read, so some of these may already be on one \(the guard skips any already on the branch you push to\)/);
    assert.match(notes, /if it has none of them, re-author it: /);
  });

  test('ADR-025 a branch that pushes to a URL no remote has gets no fix command, and no URL', () => {
    const unknown = { kind: 'url', key: 'branch.main.remote', remote: null } as const;
    const notes = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown } }));
    assert.match(notes, /this branch pushes to a URL, not a remote, so some of these may already be there \(the guard skips any already on the branch you push to\)/);
    assert.doesNotMatch(notes, /git config --local branch\.main\.remote|git fetch/);
    assert.match(notes, /if it has none of them, re-author it: git rebase abc1234 /);
  });

  test('S19 a log that could not be read is a note, and a detached HEAD is not', () => {
    const broken = context({ unpushed: { branch: 'feature', commits: err('git log failed'), unknown: null } });
    const notes = reviewNotes(broken);
    assert.match(notes, /commits on feature not on any remote could not be read \(git log failed\), so repown can't say whether the guard will refuse them/);
    assert.doesNotMatch(notes, /re-author|are by/);
    const detached = context({ unpushed: { branch: null, commits: ok([]), unknown: null } });
    assert.doesNotMatch(reviewNotes(detached), /not on any remote/);
    const hidden = context({ unpushed: { branch: 'main', unknown: null, commits: ok([
      { authorEmail: 'bad\x1b@example.invalid', committerEmail: 'octocat@example.invalid', parent: 'abc1234' },
    ]) } });
    assert.doesNotMatch(reviewNotes(hidden), /\x1b/);
    assert.match(reviewNotes(hidden), /bad\?@example\.invalid/);
  });

  test('a detected choice is a new account under its login', () => {
    assert.equal(accountOf({ account: DETECTED_PREFIX + 'octocat' }), 'octocat');
    assert.equal(accountOf({ account: DETECTED_PREFIX + 'octo-work', newAccount: 'octocat' }), 'octo-work');
    assert.equal(accountOf({ account: 'octocat' }), 'octocat');
    assert.equal(accountOf({ account: NEW_ACCOUNT, newAccount: 'octo-work' }), 'octo-work');
    assert.equal(accountOf({}), '');
    assert.equal(isNew({ account: DETECTED_PREFIX + 'octocat' }), true);
    assert.equal(isNew({ account: NEW_ACCOUNT }), true);
    assert.equal(isNew({}), true);
    assert.equal(isNew({ account: 'octocat' }), false);
  });

  test('a detected pick plans accounts add and use for the login, and no command carries +', async () => {
    const ctx = context({ recorded: {}, owner: 'octocat', ownerIsUser: true,
      detected: [{ login: 'octocat', from: ['owns this repository'] }] });
    const answers = await answer(ctx, [
      ['account', DETECTED_PREFIX + 'octocat'], ['host', 'github'],
      ['name', 'Octo Cat'], ['email', 'octocat@example.invalid'], ['guard', false], ['review', 'run'],
    ]);
    const commands = planCommands(answers, ctx);
    assert.deepEqual(commands.map((command) => command.argv), [
      ['accounts', 'add', '--name=Octo Cat', '--email=octocat@example.invalid', '--host=github', '--', 'octocat'],
      ['use', '--', 'octocat'],
    ]);
    const shown = [...commands.flatMap((command) => command.argv), ...commands.map((command) => formatCommand(command.argv))];
    for (const token of shown) assert.equal(token.includes('+'), false, token);
  });

  test('D1 a user who owns the repository is preselected when that login was detected', () => {
    const detected = [
      { login: 'octocat', from: ['owns this repository'] },
      { login: 'octo-work', from: ['signed in to gh', 'stored in Git Credential Manager'] },
    ];
    const ctx = context({ recorded: {}, owner: 'octocat', ownerIsUser: true, detected });
    const account = stepOf(ctx, 'account');
    assert.equal(account.when?.({}, ctx), true);
    assert.equal(account.initial?.({}, ctx), DETECTED_PREFIX + 'octocat');
    const choices = account.choices?.({}, ctx) ?? [];
    assert.deepEqual(choices.map((choice) => [choice.value, choice.label, choice.hint]), [
      [DETECTED_PREFIX + 'octocat', 'octocat', 'owns this repository'],
      [DETECTED_PREFIX + 'octo-work', 'octo-work', 'signed in to gh; stored in Git Credential Manager'],
      [NEW_ACCOUNT, 'a new account', 'record another account on this machine'],
    ]);
    const spelled = context({ recorded: {}, owner: 'Octocat', ownerIsUser: true, detected: detected.slice(0, 1) });
    assert.equal(stepOf(spelled, 'account').initial?.({}, spelled), DETECTED_PREFIX + 'octocat');
    const pinned = context({ pinned: 'octo-work', owner: 'octocat', ownerIsUser: true, detected: detected.slice(0, 1),
      recorded: { 'octo-work': { name: 'Octo Work', email: 'work@example.invalid', host: 'github' } } });
    assert.equal(stepOf(pinned, 'account').initial?.({}, pinned), 'octo-work');
    assert.equal(stepOf(context({ recorded: {} }), 'account').when?.({}, context({ recorded: {} })), false);
  });

  test('D2 an organisation is not offered, and a gh-only login is not preselected', () => {
    const detected = [{ login: 'octo-work', from: ['signed in to gh'] }];
    const ctx = context({ recorded: {}, owner: 'octo-org', ownerIsUser: false, detected });
    const account = stepOf(ctx, 'account');
    assert.equal(account.initial?.({}, ctx), NEW_ACCOUNT);
    assert.deepEqual((account.choices?.({}, ctx) ?? []).map((choice) => choice.label), ['octo-work', 'a new account']);
    const recorded = context({ owner: 'octo-org', ownerIsUser: false, detected });
    assert.equal(stepOf(recorded, 'account').initial?.({}, recorded), 'octocat');
  });

  test('D12 a recorded organisation stays listed and is not preselected', () => {
    const recorded = {
      'octo-org': { name: 'Octo Org', email: 'octo-org@example.invalid', host: 'github' },
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
    };
    const ctx = context({ recorded, owner: 'octo-org', ownerIsUser: false, detected: [] });
    const account = stepOf(ctx, 'account');
    const values = (account.choices?.({}, ctx) ?? []).map((choice) => choice.value);
    assert.ok(values.includes('octo-org'));
    assert.equal(account.initial?.({}, ctx), 'octocat');
    const pinned = context({ recorded, owner: 'octo-org', ownerIsUser: false, pinned: 'octo-org' });
    assert.equal(stepOf(pinned, 'account').initial?.({}, pinned), 'octo-org');
    const unknown = context({ recorded, owner: 'octo-org', ownerIsUser: null });
    assert.equal(stepOf(unknown, 'account').initial?.({}, unknown), 'octo-org');
  });

  test('D3 an owner of unknown kind is listed, not preselected, and may be an organisation', () => {
    const ctx = context({ recorded: {}, owner: 'octocat', ownerIsUser: null,
      detected: [{ login: 'octocat', from: ['owns this repository', 'signed in to gh'] }] });
    const account = stepOf(ctx, 'account');
    assert.equal(account.initial?.({}, ctx), NEW_ACCOUNT);
    assert.equal(account.choices?.({}, ctx)?.[0]?.hint, 'owns this repository; may be an organisation; signed in to gh');
    const odd = context({ recorded: {}, detected: [{ login: 'octo\x1bcat', from: ['signed in to gh\x1b'] }] });
    const choice = stepOf(odd, 'account').choices?.({}, odd)?.[0];
    assert.equal(choice?.label, 'octo\\u001bcat');
    assert.equal(choice?.hint, 'signed in to gh\\u001b');
    assert.equal(choice?.value, DETECTED_PREFIX + 'octo\x1bcat');
  });

  test('D8 the login question starts as the owner only when that owner is a user and not recorded', () => {
    const fresh = context({ recorded: {}, owner: 'octocat', ownerIsUser: true });
    const login = stepOf(fresh, 'newAccount');
    assert.equal(login.when?.({}, fresh), true);
    assert.equal(login.when?.({ account: NEW_ACCOUNT }, fresh), true);
    assert.equal(login.when?.({ account: DETECTED_PREFIX + 'octocat' }, fresh), false);
    assert.equal(login.initial?.({ account: NEW_ACCOUNT }, fresh), 'octocat');
    const org = context({ recorded: {}, owner: 'octo-org', ownerIsUser: false });
    assert.equal(stepOf(org, 'newAccount').initial?.({}, org), undefined);
    const unknown = context({ recorded: {}, owner: 'octocat', ownerIsUser: null });
    assert.equal(stepOf(unknown, 'newAccount').initial?.({}, unknown), undefined);
    const known = context({ owner: 'octocat', ownerIsUser: true });
    assert.equal(stepOf(known, 'newAccount').initial?.({}, known), undefined);
    const cased = context({ owner: 'Octocat', ownerIsUser: true });
    assert.equal(stepOf(cased, 'newAccount').initial?.({}, cased), undefined);
  });

  test('D7 a new account is shown the machine default, which is never filled in', async () => {
    const machine = { name: 'Octo Work', email: 'octo-work@example.invalid' };
    const nameLine = 'your default git name here is Octo Work: use it only if this account does too';
    const addressLine = 'your default git address here is octo-work@example.invalid: use it only if this account does too';
    const ctx = context({
      recorded: {}, owner: 'octocat', ownerIsUser: true, machineIdentity: machine,
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const fresh = { account: NEW_ACCOUNT, newAccount: 'octocat', host: 'github' };
    const name = stepOf(ctx, 'name');
    const email = stepOf(ctx, 'email');
    assert.equal((await name.detail?.(fresh, ctx)), nameLine);
    const shown = (await email.detail?.(fresh, ctx)) ?? '';
    assert.equal(shown.endsWith('; ' + addressLine), true, shown);
    assert.match(shown, /^tip: to keep your own address private[\s\S]*1234\+octocat@users\.noreply\.github\.com; your default git address here/);
    assert.doesNotMatch(shown, /Octo Work <|·/);
    assert.equal(await name.initial?.(fresh, ctx), 'Octo Cat');
    assert.equal(await email.initial?.(fresh, ctx), 'octocat@example.invalid');

    const unnamed = context({ recorded: {}, machineIdentity: { name: null, email: 'octo-work@example.invalid' } });
    assert.equal((await stepOf(unnamed, 'name').detail?.(fresh, unnamed)), 'this is the login', 'no name found: the prefill is the login, and it says so');
    const unnamedEmail = (await stepOf(unnamed, 'email').detail?.(fresh, unnamed)) ?? '';
    assert.match(unnamedEmail, /your default git address here is octo-work@example\.invalid/);
    assert.doesNotMatch(unnamedEmail, /Octo Work </);

    const recorded = context({ machineIdentity: machine });
    const known = { account: 'octocat' };
    assert.equal((await stepOf(recorded, 'name').detail?.(known, recorded)), undefined);
    assert.doesNotMatch((await stepOf(recorded, 'email').detail?.(known, recorded)) ?? '', /default git address/);

    const noEmail = context({ recorded: {}, machineIdentity: { name: 'Octo Work', email: null } });
    assert.equal((await stepOf(noEmail, 'name').detail?.(fresh, noEmail)), 'this is the login; ' + nameLine);
    const tipOnly = (await stepOf(noEmail, 'email').detail?.(fresh, noEmail)) ?? '';
    assert.doesNotMatch(tipOnly, /default git address/);
    assert.match(tipOnly, /noreply/);

    const bare = context({ recorded: {}, machineIdentity: machine });
    const typed = { account: NEW_ACCOUNT, newAccount: 'octocat' };
    assert.equal(await stepOf(bare, 'name').initial?.(typed, bare), 'octocat');
    assert.equal(await stepOf(bare, 'email').initial?.(typed, bare), undefined);
  });

  test('D11 a recorded owner is preselected over the first recorded account', () => {
    const recorded = {
      'octo-work': { name: 'Octo Work', email: 'octo-work@example.invalid', host: 'github' },
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
    };
    const ctx = context({ recorded, owner: 'octocat', ownerIsUser: null });
    assert.equal(stepOf(ctx, 'account').initial?.({}, ctx), 'octocat');
    const pinned = context({ recorded, owner: 'octocat', pinned: 'octo-work' });
    assert.equal(stepOf(pinned, 'account').initial?.({}, pinned), 'octo-work');
    const spelled = context({
      recorded: { 'octo-work': recorded['octo-work'], Octocat: recorded.octocat },
      owner: 'octocat',
    });
    assert.equal(stepOf(spelled, 'account').initial?.({}, spelled), 'Octocat');
  });

  test('D13 a pin matches the registry without case and wins over the recorded owner', () => {
    const recorded = {
      'octo-work': { name: 'Octo Work', email: 'octo-work@example.invalid', host: 'github' },
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
    };
    const ctx = context({ recorded, pinned: 'Octo-Work', owner: 'octocat', ownerIsUser: true });
    assert.equal(stepOf(ctx, 'account').initial?.({}, ctx), 'octo-work');
  });

  test('S16 a pin lists the keys pinWrites would write, and nothing else', () => {
    const ctx = context();
    const answers = { account: 'octocat', mode: 'step' as const };
    const lines = changesOf(['use', '--', 'octocat'], answers, ctx);
    const written = pinWrites(
      { name: 'Octo Cat', email: 'octocat@example.invalid', account: 'octocat' },
      ctx.credentialKeys,
    ).map(([key, value]) => key + ' = ' + value);
    assert.deepEqual(lines, written);
    assert.deepEqual(lines, [
      'user.name = Octo Cat',
      'user.email = octocat@example.invalid',
      'user.useConfigOnly = true',
      'repown.account = octocat',
      'credential.https://github.com.username = octocat',
    ]);
  });

  test('S16 a host repown does not pin omits the credential key', () => {
    const ctx = context({ credentialPinned: false, credentialKeys: ['credential.https://github.com.username'] });
    assert.deepEqual(changesOf(['use', '--', 'octocat'], { account: 'octocat' }, ctx), [
      'user.name = Octo Cat',
      'user.email = octocat@example.invalid',
      'user.useConfigOnly = true',
      'repown.account = octocat',
    ]);
  });

  test('S16 use --gh names a switch when gh lists the account, and a browser sign-in otherwise', () => {
    const listed = context({ gh: ok({ accounts: [{ login: 'octocat', active: false }], active: 'octo-work' }) });
    const switched = changesOf(['use', '--gh', '--', 'octocat'], { account: 'octocat', gh: true }, listed);
    assert.ok(switched.includes('gh: switch the active account to octocat'));
    assert.ok(switched.includes('user.name = Octo Cat'));
    const fresh = context({ gh: ok({ accounts: [], active: null }) });
    const signingIn = changesOf(['use', '--gh', '--', 'octocat'], { account: 'octocat', gh: true }, fresh);
    assert.ok(signingIn.includes('gh: sign in as octocat (opens a browser)'));
    assert.equal(signingIn.includes('gh: switch the active account to octocat'), false);
  });

  test('S16 every other planned command says what it writes', () => {
    const ctx = context({
      owner: 'octo-org',
      hookPath: '/work/project/.git/hooks/pre-push',
      fixLines: ['    global:  credential.https://github.com.helper', ''],
    });
    const allow = ['git', 'config', '--local', '--add', 'repown.allowOwner', 'octo-org'];
    assert.deepEqual(changesOf(allow, {}, ctx), ['repown.allowOwner += octo-org']);
    assert.deepEqual(changesOf(['git', 'config', '--local', 'push.autoSetupRemote', 'true'], {}, ctx), ['push.autoSetupRemote = true']);
    const hook = 'pre-push hook: /work/project/.git/hooks/pre-push runs repown guard check';
    assert.deepEqual(changesOf(['guard', 'on'], {}, ctx), [hook]);
    const fallback = 'pre-push hook: this clone\'s pre-push hook runs repown guard check';
    assert.deepEqual(changesOf(['guard', 'on'], {}, context()), [fallback]);
    const added = changesOf(['accounts', 'add', '--', 'octo-work'], {
      account: NEW_ACCOUNT, newAccount: 'octo-work', name: 'Octo Work', email: 'work@example.invalid',
    }, ctx);
    assert.deepEqual(added, ['this machine\'s account registry: octo-work = Octo Work work@example.invalid']);
    assert.deepEqual(changesOf(['fix', '--yes'], {}, ctx), ['    global:  credential.https://github.com.helper']);
  });

  test('S16 Enter is Yes, and Skip when the step is fix; why is the step\'s own words', () => {
    const ctx = context({ fixLines: ['    global:  credential.https://github.com.helper'] });
    const answers = { account: 'octocat', fix: true, guard: true, mode: 'step' as const };
    const plan = planCommands(answers, ctx);
    const fix = plan.find((item) => item.argv[0] === 'fix');
    const use = plan.find((item) => item.argv[0] === 'use');
    assert.ok(fix && use);
    assert.equal(briefOf(fix, answers, ctx).initial, 'skip');
    assert.equal(briefOf(use, answers, ctx).initial, 'yes');
    assert.equal(briefOf(use, answers, ctx).why, use.what);
    assert.equal(briefOf(use, answers, ctx).command, formatCommand(use.argv));
    assert.ok(briefOf(fix, answers, ctx).why.includes('whole machine'));
  });

  test('the plain prompter shows the change, the reason and the command, and Enter takes the default', async () => {
    const yes = await plainChoice('\n', 'yes');
    assert.equal(yes.choice, 'yes');
    assert.match(yes.shown, /user\.name = Octo Cat/);
    assert.match(yes.shown, /Pin this clone to octocat: its commit name, email and push sign-in/);
    assert.match(yes.shown, /\$ repown use octocat/);
    assert.match(yes.shown, /Run this step\?/);
    assert.match(yes.shown, /1\) Yes/);
    assert.match(yes.shown, /2\) Skip/);
    assert.match(yes.shown, /3\) Stop/);
    assert.equal((await plainChoice('\n', 'skip')).choice, 'skip');
    assert.equal((await plainChoice('3\n', 'yes')).choice, 'stop');
    assert.equal((await plainChoice('', 'yes')).choice, CANCEL);
  });
});

describe('the setup lead on the plain prompter', () => {
  test('F7: the lead is indented two spaces', async () => {
    const box = sandbox();
    const saved = process.env['PATH'];
    process.env['PATH'] = pathWithoutGh(saved ?? '');
    try {
      const shown = await plainLead(box);
      const lines = shown.split('\n').filter((line) => /isn't set up yet|shows its settings/.test(line));
      assert.ok(lines.length > 0, shown);
      for (const line of lines) assert.match(line, /^ {2}\S/, shown);
    } finally {
      if (saved === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved;
      box.dispose();
    }
  });
});

describe('Ctrl-C during gh sign-in', () => {
  test('a SIGINT while inherit is running still runs the next setup step', async () => {
    const at = home();
    record(at, 'octocat', 'octocat@example.invalid');
    const captured = captureStep(() => { process.emit('SIGINT'); });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await holdInherit();
      captured.begin();
      const code = await runSetup(guarded(at), { interactive: false });
      assert.equal(code, 0, captured.text());
      assert.match(captured.text(), /step 2 of 2/);
      assert.doesNotMatch(captured.text(), /interrupted/);
      assert.ok(existsSync(hook(at)));
    } finally {
      captured.end();
      await release?.();
      at.dispose();
    }
  });
});

describe('setup: point the branch back at its remote, fetch the destination first', () => {
  const THEIRS = 'old@example.invalid';
  const foreign = { authorEmail: THEIRS, committerEmail: THEIRS, parent: null };
  const repoint = (tracked: boolean): Partial<SetupContext> =>
    ({ push: { ...context().push, repoint: { key: 'branch.main.remote', remote: 'origin', tracked } } });
  const behindUrl: SetupContext['unpushed'] = { branch: 'main', commits: ok([foreign]), unknown: { kind: 'url', key: 'branch.main.remote', remote: 'origin' } };
  const unfetched: SetupContext['unpushed'] = { branch: 'main', commits: ok([foreign]), unknown: { kind: 'remote', name: 'origin' } };
  const recommended = (ctx: SetupContext): Answers => setupFlow(ctx).fill!({ mode: 'recommended', account: 'octocat' }, ctx);
  const plan = (answers: Answers, ctx: SetupContext): (readonly string[])[] => planCommands(answers, ctx).map((command) => command.argv);

  test('Recommended repoints first, and the review shows the key and the remote, never the URL', () => {
    const ctx = context(repoint(true));
    const answers = recommended(ctx);
    const [first] = planCommands(answers, ctx);
    assert.deepEqual(first?.argv, ['git', 'config', '--local', 'branch.main.remote', 'origin']);
    assert.equal(formatCommand(first!.argv), 'git config --local branch.main.remote origin');
    assert.deepEqual(changesOf(first!.argv, answers, ctx), ['branch.main.remote = origin']);
    assert.match(first!.what, /origin/);
  });

  test('Recommended fetches first only for commits by another address behind a remote never fetched', () => {
    const ctx = context({ unpushed: unfetched });
    const argv = plan(recommended(ctx), ctx);
    assert.deepEqual(argv[0], ['git', 'fetch', 'origin']);
    assert.ok(argv.findIndex((line) => line[0] === 'use') > 0, 'fetch runs before the pin');
    const clean = context({ unpushed: { ...unfetched, commits: ok([]) } });
    assert.equal(plan(recommended(clean), clean).some((line) => line.includes('fetch')), false, 'a clean clone never fetches');
    const known = context({ unpushed: { ...unfetched, unknown: null } });
    assert.equal(plan(recommended(known), known).some((line) => line.includes('fetch')), false, 'a known destination needs no fetch');
    const mine = { ...foreign, authorEmail: 'octocat@example.invalid', committerEmail: 'octocat@example.invalid' };
    const own = context({ unpushed: { ...unfetched, commits: ok([mine]) } });
    assert.equal(plan(recommended(own), own).some((line) => line.includes('fetch')), false, 'own commits need no fetch');
  });

  test('behind a URL: repoint, then fetch the remote only when it has no tracking refs', () => {
    const untracked = context({ ...repoint(false), unpushed: behindUrl });
    assert.deepEqual(plan(recommended(untracked), untracked).slice(0, 2),
      [['git', 'config', '--local', 'branch.main.remote', 'origin'], ['git', 'fetch', 'origin']]);
    const tracked = context({ ...repoint(true), unpushed: behindUrl });
    assert.equal(plan(recommended(tracked), tracked).some((line) => line.includes('fetch')), false);
    const kept = setupFlow(untracked).fill!({ mode: 'recommended', account: 'octocat', repoint: false }, untracked);
    assert.equal(plan(kept, untracked).some((line) => line.includes('fetch')), false, 'the URL stays: fetching origin says nothing about it');
  });

  test('--fetch given as a flag still fetches behind a URL that the repoint will fix', () => {
    const ctx = context({ ...repoint(false), unpushed: behindUrl });
    const given = { account: 'octocat', mode: 'recommended', fetch: true };
    const kept = keptFlags(given, ctx).answers;
    assert.equal(kept['fetch'], true, 'the repoint has not been asked yet, and Recommended answers it Yes');
    assert.deepEqual(plan(setupFlow(ctx).fill!(kept, ctx), ctx).slice(0, 2),
      [['git', 'config', '--local', 'branch.main.remote', 'origin'], ['git', 'fetch', 'origin']]);
    const unattended = keptFlags({ ...given, repoint: false }, ctx);
    assert.equal(unattended.answers['fetch'], false, 'without --repoint the URL stays, so there is nothing to fetch');
    assert.match(unattended.notes.join('\n'), /--fetch: .*add --repoint/);
  });

  test('with --cwd, both lines name the clone', () => {
    const ctx = context({ ...repoint(false), unpushed: behindUrl, cwd: 'repo' });
    assert.deepEqual(plan(recommended(ctx), ctx).slice(0, 2),
      [['git', '-C', 'repo', 'config', '--local', 'branch.main.remote', 'origin'], ['git', '-C', 'repo', 'fetch', 'origin']]);
  });

  test('each git line is read by its shape, not by a word a name could also be', () => {
    assert.equal(gitStepOf(['git', 'config', '--local', '--add', 'repown.allowOwner', 'fetch']), 'allowOwner');
    assert.equal(gitStepOf(['git', '-C', 'fetch', 'config', '--local', 'push.autoSetupRemote', 'true']), 'upstream');
    assert.equal(gitStepOf(['git', 'fetch', 'push.autoSetupRemote']), 'fetch');
    assert.equal(gitStepOf(['git', 'config', '--local', 'branch.main.remote', 'origin']), 'repoint');
    assert.equal(gitStepOf(['git', 'push', 'origin']), null);
    assert.equal(gitStepOf(['git', 'fetch', 'origin', '--prune']), null);
  });

  test('--no-input without the flags does neither; Step by step asks both', () => {
    const ctx = context({ ...repoint(false), unpushed: behindUrl });
    const none = { account: 'octocat', repoint: false, fetch: false, guard: false, gh: false, fix: false, upstream: false, allowOwner: false };
    assert.equal(plan(none, ctx).some((line) => line[0] === 'git'), false);
    const asked = setupFlow(ctx).steps.filter((step) => step.when?.({ mode: 'step', account: 'octocat', repoint: true }, ctx) ?? true);
    const ids = asked.map((step) => step.id);
    assert.ok(ids.includes('repoint') && ids.includes('fetch'), ids.join(','));
  });
});

describe('setup: re-author the commits by another address, only when asked', () => {
  const theirs = { authorEmail: 'old@example.invalid', committerEmail: 'old@example.invalid', parent: 'abc1234' };
  const foreignCtx = (overrides: Partial<SetupContext> = {}): SetupContext =>
    context({ unpushed: { branch: 'main', commits: ok([theirs]), unknown: null }, ...overrides });
  const asked = (ctx: SetupContext, answers: Answers): string[] =>
    setupFlow(ctx).steps.filter((step) => step.when?.(answers, ctx) ?? true).map((step) => step.id);

  test('asked in both modes, default No, and only with commits by another address', () => {
    const ctx = foreignCtx();
    const step = setupFlow(ctx).steps.find((candidate) => candidate.id === 'reauthor');
    assert.equal(step?.auto, undefined, 'Recommended asks it: it never answers Yes itself');
    assert.equal(step?.initial?.({}, ctx), false);
    assert.ok(asked(ctx, { mode: 'recommended', account: 'octocat' }).includes('reauthor'));
    assert.ok(asked(ctx, { mode: 'step', account: 'octocat' }).includes('reauthor'));
    assert.equal(asked(context(), { mode: 'step', account: 'octocat' }).includes('reauthor'), false);
    const mine = context({ unpushed: { branch: 'main', commits: ok([{ ...theirs, authorEmail: 'octocat@example.invalid', committerEmail: 'octocat@example.invalid' }]), unknown: null } });
    assert.equal(asked(mine, { mode: 'step', account: 'octocat' }).includes('reauthor'), false);
  });

  test('Yes runs `reauthor --yes` last, after the pin, the guard and a fetch; No leaves it out', () => {
    const ctx = foreignCtx({ unpushed: { branch: 'main', commits: ok([theirs]), unknown: { kind: 'remote', name: 'origin' } }, cwd: 'repo' });
    const answers = setupFlow(ctx).fill!({ mode: 'recommended', account: 'octocat', reauthor: true }, ctx);
    const argv = planCommands(answers, ctx).map((command) => command.argv);
    assert.deepEqual(argv.at(-1), ['reauthor', '--yes', '--cwd=repo']);
    assert.deepEqual(argv[0], ['git', '-C', 'repo', 'fetch', 'origin']);
    const no = setupFlow(ctx).fill!({ mode: 'recommended', account: 'octocat', reauthor: false }, ctx);
    assert.equal(planCommands(no, ctx).some((command) => command.argv[0] === 'reauthor'), false);
  });

  test('a settled clone with commits by another address offers Re-author them, which reviews that one step', async () => {
    const ctx = foreignCtx({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    const offered = scripted([['review', 'reauthor'], ['review', 'decline']]);
    assert.deepEqual(await wizard(setupFlow(ctx), ctx, {}, offered), { status: 'declined' });
    assert.equal(offered.reviews[0]?.settled, true);
    assert.equal(offered.reviews[0]?.reauthorOffer, 'Re-author them as octocat');
    assert.equal(offered.reviews[1]?.settled, false);
    assert.deepEqual(offered.reviews[1]?.steps.map((step) => step.command), ['repown reauthor --yes']);
    const clean = context({ pinned: 'octocat', pinIntact: true, guard: 'on' });
    assert.equal(setupFlow(clean).opening!(clean)?.reauthorOffer, undefined, 'nothing to re-author, nothing offered');
  });

  test('with the guard off, commits by another address are a warning: done, not a push that will fail', () => {
    const off = foreignCtx({ pinned: 'octocat', pinIntact: true, guard: 'off', upstream: { supported: true, enabled: true, branch: 'main', tracked: null } });
    const answers = { mode: 'recommended', account: 'octocat', guard: false };
    const shown = setupFlow(off).review(answers, off);
    assert.equal(shown.blocked ?? false, false);
    assert.match(shown.notes.join(' '), /the guard is off, so (it|they) push/);
    assert.equal(blockersOf(answers, off).some((blocker) => blocker.blocks), false);
    const on = { ...answers, guard: true };
    assert.equal(blockersOf(on, off).some((blocker) => blocker.blocks), true, 'turning the guard on in this run makes them block');
  });

  test('rewriting history needs a deliberate yes: Enter is Decline at the review and Skip at the step', () => {
    const ctx = foreignCtx();
    const answers = setupFlow(ctx).fill!({ mode: 'recommended', account: 'octocat', reauthor: true }, ctx);
    const shown = setupFlow(ctx).review(answers, ctx);
    assert.equal(reviewDefault(shown), 'decline');
    const planned = planCommands(answers, ctx).find((command) => command.argv[0] === 'reauthor')!;
    const brief = briefOf(planned, answers, ctx);
    assert.equal(brief.initial, 'skip');
    assert.match(brief.changes.join('\n'), /old@example\.invalid .*octocat@example\.invalid.*refs\/repown\/backup\//);
  });
});

test('a new account\'s name question first says what GitHub said about the login, then the machine name', async () => {
  const ctx = context({
    recorded: {}, machineIdentity: { name: 'Octo Work', email: null },
    suggest: async () => ({ problem: 'github.com has no account named octocatt: check the spelling' }),
  });
  const fresh = { account: NEW_ACCOUNT, newAccount: 'octocatt', host: 'github' };
  assert.equal(await stepOf(ctx, 'name').detail?.(fresh, ctx),
    'github.com has no account named octocatt: check the spelling; your default git name here is Octo Work: use it only if this account does too');
  const quiet = context({ recorded: {}, suggest: async () => ({ problem: null }) });
  assert.equal(await stepOf(quiet, 'name').detail?.(fresh, quiet), 'this is the login', 'a lookup that failed says only where the prefill came from');
});

test('the name question says when this machine is signed in to GitHub as others, not this login', async () => {
  const fresh = { account: NEW_ACCOUNT, newAccount: 'octocat', host: 'github' };
  const named = { name: 'Octo Cat', email: '1234+octocat@users.noreply.github.com' };
  const detail = async (signedIn: readonly string[] | null, suggestion: Suggestion = named, answers: Answers = fresh): Promise<string | undefined> => {
    const ctx = context({ recorded: {}, signedIn: async () => signedIn, suggest: async () => suggestion });
    return stepOf(ctx, 'name').detail?.(answers, ctx);
  };
  const note = 'signed in as octo-work, octo-org, not octocat: if octocat isn\'t your account, go back; otherwise the first push asks you to sign in as it';
  assert.equal(await detail(['octo-work', 'octo-org']), note);
  assert.equal(await detail(['octo-work', 'OctoCat']), undefined, 'the login is one of them, in any case');
  assert.equal(await detail(null), undefined, 'neither gh nor Git Credential Manager could be read');
  assert.equal(await detail([]), undefined, 'signed in as nobody: nothing to compare with');
  assert.equal(await detail(['octo-work'], { problem: 'github.com has no account named octocat: check the spelling' }),
    'github.com has no account named octocat: check the spelling', 'a missing account says only that');
  assert.equal(await detail(['octo-work'], {}, { ...fresh, host: 'azdo' }), 'this is the login', 'only GitHub sign-ins are read');
  assert.equal(await detail(['octo-work'], {}),
    'signed in as octo-work, not octocat: if octocat isn\'t your account, go back; otherwise the first push asks you to sign in as it; this is the login');
  assert.equal(await detail(['octo-work'], {}, { ...fresh, name: 'Octo Cat' }),
    'signed in as octo-work, not octocat: if octocat isn\'t your account, go back; otherwise the first push asks you to sign in as it',
    'back on the question after typing a name: it no longer starts as the login');
});

test('signedInLogins joins gh\'s and Git Credential Manager\'s accounts, once each, and is null when neither reads', () => {
  const gh = ok({ accounts: [{ login: 'octo-org', active: true }, { login: 'octo-work', active: false }], active: 'octo-org' });
  assert.deepEqual(signedInLogins(gh, ok(['Octo-Org', 'octocat'])), ['octo-org', 'octo-work', 'octocat']);
  assert.deepEqual(signedInLogins(null, ok(['octocat'])), ['octocat']);
  assert.deepEqual(signedInLogins(err('gh auth status failed'), null), null);
  assert.deepEqual(signedInLogins(null, err('no GCM')), null);
  assert.deepEqual(signedInLogins(ok({ accounts: [], active: null }), null), []);
});

test('the name and email questions say where their prefill came from', async () => {
  const fresh = { account: NEW_ACCOUNT, newAccount: 'octocat', host: 'github' };
  const details = async (suggestion: Suggestion, answers: Answers = fresh): Promise<(string | undefined)[]> => {
    const ctx = context({ recorded: {}, machineIdentity: { name: null, email: null }, suggest: async () => suggestion });
    return [await stepOf(ctx, 'name').detail?.(answers, ctx), await stepOf(ctx, 'email').detail?.(answers, ctx)];
  };
  const noreply = '843102+octocat@users.noreply.github.com';
  assert.deepEqual(await details({ email: noreply }), ['GitHub gives no usable name for octocat, so this is the login',
    'prefilled with the private address GitHub gives octocat (github.com/settings/emails)']);
  assert.deepEqual(await details({ name: 'Octo Cat', email: noreply }),
    [undefined, 'prefilled with the private address GitHub gives octocat (github.com/settings/emails)']);
  const [, retyped] = await details({ email: noreply }, { ...fresh, email: 'octocat@example.invalid' });
  assert.match(retyped ?? '', /^tip:/, 'back on the question after typing an address: it no longer holds the prefill');
  const [offlineName, offlineEmail] = await details({});
  assert.equal(offlineName, 'this is the login');
  assert.match(offlineEmail ?? '', /^tip: to keep your own address private[\s\S]*like 1234\+octocat@users\.noreply\.github\.com$/);
  const [, typedEmail] = await details({ name: 'Octo Cat', email: 'octocat@example.invalid' });
  assert.match(typedEmail ?? '', /^tip:/, 'an address that is not GitHub\'s private one keeps the tip');
  const azure = { ...fresh, host: 'azdo' };
  assert.deepEqual(await details({}, azure), ['this is the login', undefined]);
});
