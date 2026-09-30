// `repown setup`: the flow (which steps, what they turn into) with a scripted
// prompter and a hand-built context, then the command itself -- in-process with a
// scripted prompter for the interactive paths, and spawned for the paths a script
// or CI would take. Every run happens in a sandbox (isolated git config, registry).

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
import { setupFlow, planCommands, formatCommand, gitStepOf, keptFlags, blockersOf, changesOf, briefOf, missingFlags, printable, NEW_ACCOUNT, DETECTED_PREFIX, accountOf, isNew, type SetupContext } from '../src/wizard/setup-flow.ts';
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

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
plainTerminal();

// ---------------------------------------------------------------- the flow

type Entry = readonly [string, Reply | ReviewChoice];

function scripted(script: Entry[]): Prompter & { readonly asked: string[]; readonly reviews: Review[]; readonly confirms: StepConfirm[] } {
  const queue = [...script];
  const next = (id: string): Reply | ReviewChoice => {
    const entry = queue.shift();
    assert.ok(entry, 'script ran out at ' + id);
    assert.equal(entry[0], id, 'the wizard asked ' + id + ', the script expected ' + entry[0]);
    return entry[1];
  };
  const asked: string[] = [];
  const reviews: Review[] = [];
  const confirms: StepConfirm[] = [];
  return {
    asked,
    reviews,
    confirms,
    ask: async (step) => { asked.push(step.id); return next(step.id) as Reply; },
    review: async (review) => { reviews.push(review); return next('review') as ReviewChoice; },
    pickStep: async () => next('pick') as string,
    choose: async () => { throw new Error('setup does not choose'); },
    note: () => {},
    close: () => {},
    confirmStep: async (brief) => {
      confirms.push(brief);
      const choice = next('step');
      return choice === CANCEL ? CANCEL : choice as 'yes' | 'skip' | 'stop';
    },
  };
}

/** Step by step, so a script is asked every question. Pass `mode` in `given` to drive Recommended. */
async function answer(ctx: SetupContext, script: Entry[], given: Answers = {}): Promise<Answers> {
  const mode = given['mode'] === undefined ? { mode: 'step' } : {};
  const outcome = await wizard(setupFlow(ctx), ctx, { ...mode, ...given }, scripted(script));
  assert.equal(outcome.status, 'run');
  return outcome.status === 'run' ? outcome.answers : {};
}

/** Every line of text a review shows. */
const textOf = (review: Review): string[] =>
  [review.title, ...review.headline, ...review.notes, ...review.steps.flatMap((step) => [step.what, step.command, ...step.detail])];

const argvOf = (answers: Answers, ctx: SetupContext): (readonly string[])[] =>
  planCommands(answers, ctx).map((command) => command.argv);

/** Newest first, as git log lists them; the oldest commit's parent is `rebaseBase`. */
function onBranch(emails: readonly string[], rebaseBase = 'abc1234'): SetupContext['unpushed'] {
  const parentOf = (index: number): string | null =>
    index < emails.length - 1 ? 'fff' + index : rebaseBase === '--root' ? null : rebaseBase;
  return {
    branch: 'main',
    commits: ok(emails.map((address, index) => ({ authorEmail: address, committerEmail: address, parent: parentOf(index) }))),
    unknown: null,
  };
}

function reviewNotes(ctx: SetupContext, answers: Answers = { account: 'octocat' }): string {
  return setupFlow(ctx).review(answers, ctx).notes.join('\n');
}

/** A commit-tree whose committer date is fixed, so log order does not depend on the clock. */
function commitAt(box: Sandbox, date: string, args: readonly string[]): string {
  const saved = { author: process.env['GIT_AUTHOR_DATE'], committer: process.env['GIT_COMMITTER_DATE'] };
  process.env['GIT_AUTHOR_DATE'] = date;
  process.env['GIT_COMMITTER_DATE'] = date;
  try {
    return box.git(...args);
  } finally {
    restoreEnv('GIT_AUTHOR_DATE', saved.author);
    restoreEnv('GIT_COMMITTER_DATE', saved.committer);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
    assert.equal(step.detail?.(picked, ctx), 'gh\'s active account is octo-work');
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
    assert.equal(step.detail?.(picked, ctx), 'gh\'s active account is octo-work');
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
    assert.equal(stepOf(ctx, 'gh').detail?.({ account: 'octocat' }, ctx), 'gh isn\'t signed in to any account');
    assert.equal(stepOf(ctx, 'gh').when?.({ account: 'octocat' }, ctx), true);
  });

  test('a fresh gh, from the empty hosts fixture, is offered a sign-in', () => {
    const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const ctx = context({ gh: parsed });
    const step = stepOf(ctx, 'gh');
    const picked = { account: 'octocat' };
    assert.equal(step.when?.(picked, ctx), true);
    assert.equal(wording(step.message, picked, ctx), 'Sign in to gh as octocat too?');
    assert.equal(step.detail?.(picked, ctx), 'gh isn\'t signed in to any account');
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
      "repown accounts add octocat '--name=-dash' --email a@example.invalid");
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
      "repown accounts add octocat --name 'Octo Cat' --email a@example.invalid");
    assert.equal(formatCommand(['use', '--gh', '--', '-odd']), 'repown use --gh -- -odd');
    assert.equal(formatCommand(['git', 'config', '--local', '--add', 'repown.allowOwner', 'octo-org']),
      'git config --local --add repown.allowOwner octo-org');
  });

  test('control characters are shown escaped, so nothing can redraw the review', () => {
    const shown = formatCommand(['use', '--', 'octo\x1b[2Jcat']);
    assert.doesNotMatch(shown, /\x1b/);
    assert.match(shown, /\\u001b/);
    const ctx = context({ owner: 'octo\x1b]0;x\x07org' });
    for (const line of textOf(setupFlow(ctx).review({ account: 'octocat', guard: true }, ctx))) {
      assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
    }
  });

  test('a new account login must be a plain name: no spaces, slashes, ? or #', () => {
    const newAccount = setupFlow(context()).steps.find((step) => step.id === 'newAccount')!;
    for (const bad of [' octo-work', 'octo work', 'octo/work', '../user', 'a?b', 'a#b', 'a\x1bb']) {
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

  test('the guard question says when a repository has no commits yet', () => {
    const guard = setupFlow(context()).steps.find((step) => step.id === 'guard')!;
    assert.match(guard.detail!({ account: 'octocat' }, context()) ?? '', /no commits yet/);
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

  test('a history that could not be read is said, not shown as clean', () => {
    const flow = setupFlow(context({ addresses: err('git log failed') }));
    const guard = flow.steps.find((step) => step.id === 'guard')!;
    assert.match(guard.detail?.({ account: 'octocat' }, context({ addresses: err('git log failed') })) ?? '', /could not be read/);
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
    assert.match(notes, /my fork has no remote-tracking refs, so some of these may already be on it \(the guard skips any already on the branch you push to\): git fetch 'my fork', then repown use octocat to count again/);
    assert.match(notes, /if my fork has none of them, re-author it: git rebase --root /);
    assert.doesNotMatch(notes, /^\s*re-author/m);
  });

  test('ADR-025 a name git would read as an option gets no command, and hidden text is shown', () => {
    const dashed = { kind: 'remote', name: '--upload-pack=touch x' } as const;
    const notes = reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: dashed } }));
    assert.match(notes, /--upload-pack=touch x has no remote-tracking refs, so some of these may already be on it \(the guard skips any already on the branch you push to\)/);
    assert.doesNotMatch(notes, /git fetch/);
    const url = { kind: 'url', key: 'branch.main.remote', remote: '-o' } as const;
    assert.doesNotMatch(reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: url } })), /git config|git fetch/);
    const bidi = { kind: 'remote', name: 'fork\u202egnp.exe\u200b' } as const;
    assert.match(reviewNotes(context({ unpushed: { ...onBranch(['old@example.invalid']), unknown: bidi } })), /git fetch 'fork\?gnp\.exe\?'/);
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
    const nameLine = 'not this machine\'s default name (Octo Work), unless this account uses it';
    const addressLine = 'not this machine\'s default address (octo-work@example.invalid), unless this account uses it';
    const ctx = context({
      recorded: {}, owner: 'octocat', ownerIsUser: true, machineIdentity: machine,
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const fresh = { account: NEW_ACCOUNT, newAccount: 'octocat', host: 'github' };
    const name = stepOf(ctx, 'name');
    const email = stepOf(ctx, 'email');
    assert.equal(name.detail?.(fresh, ctx), nameLine);
    const shown = email.detail?.(fresh, ctx) ?? '';
    assert.equal(shown.endsWith('; ' + addressLine), true, shown);
    assert.match(shown, /^tip: to keep your own address private[\s\S]*1234\+octocat@users\.noreply\.github\.com; not this machine's default address/);
    assert.doesNotMatch(shown, /Octo Work <|·|type it/);
    assert.equal(await name.initial?.(fresh, ctx), 'Octo Cat');
    assert.equal(await email.initial?.(fresh, ctx), 'octocat@example.invalid');

    const unnamed = context({ recorded: {}, machineIdentity: { name: null, email: 'octo-work@example.invalid' } });
    assert.equal(stepOf(unnamed, 'name').detail?.(fresh, unnamed), undefined);
    const unnamedEmail = stepOf(unnamed, 'email').detail?.(fresh, unnamed) ?? '';
    assert.match(unnamedEmail, /not this machine's default address \(octo-work@example\.invalid\)/);
    assert.doesNotMatch(unnamedEmail, /Octo Work </);

    const recorded = context({ machineIdentity: machine });
    const known = { account: 'octocat' };
    assert.equal(stepOf(recorded, 'name').detail?.(known, recorded), undefined);
    assert.doesNotMatch(stepOf(recorded, 'email').detail?.(known, recorded) ?? '', /this machine's default/);

    const noEmail = context({ recorded: {}, machineIdentity: { name: 'Octo Work', email: null } });
    assert.equal(stepOf(noEmail, 'name').detail?.(fresh, noEmail), nameLine);
    const tipOnly = stepOf(noEmail, 'email').detail?.(fresh, noEmail) ?? '';
    assert.doesNotMatch(tipOnly, /this machine's default/);
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
    assert.match(yes.shown, /> repown use octocat/);
    assert.match(yes.shown, /Run this step\?/);
    assert.match(yes.shown, /1\) Yes/);
    assert.match(yes.shown, /2\) Skip/);
    assert.match(yes.shown, /3\) Stop/);
    assert.equal((await plainChoice('\n', 'skip')).choice, 'skip');
    assert.equal((await plainChoice('3\n', 'yes')).choice, 'stop');
    assert.equal((await plainChoice('', 'yes')).choice, CANCEL);
  });
});

async function plainChoice(keys: string, initial: 'yes' | 'skip'): Promise<{ choice: unknown; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = plainPrompter({ input, output });
  if (keys) input.write(keys);
  else input.end();
  const choice = await prompter.confirmStep({
    changes: ['user.name = Octo Cat'],
    why: 'Pin this clone to octocat: its commit name, email and push sign-in',
    command: 'repown use octocat',
    initial,
  });
  prompter.close();
  return { choice, shown };
}

function stepOf(ctx: SetupContext, id: string) {
  const found = setupFlow(ctx).steps.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

function wording(text: string | ((answers: Answers, ctx: SetupContext) => string), answers: Answers, ctx: SetupContext): string {
  return typeof text === 'function' ? text(answers, ctx) : text;
}

/** A POSIX shell's word splitting, for the single-quoted words formatCommand produces. */
function shellSplit(line: string): string[] {
  return [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((match) =>
    match[1] !== undefined ? match[1].replaceAll("'\\''", "'") : match[2]!);
}

// ---------------------------------------------------------------- the command

interface Home {
  readonly box: Sandbox;
  readonly registry: string;
  readonly dispose: () => void;
}

function home(): Home {
  const box = sandbox();
  const registry = mkdtempSync(join(tmpdir(), 'repown-registry-'));
  const saved = process.env['REPOWN_CONFIG_DIR'];
  process.env['REPOWN_CONFIG_DIR'] = registry;
  // By the account most tests pin, so the clone has no commit by another address unless a test makes one.
  box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  return { box, registry, dispose: () => {
    if (saved === undefined) delete process.env['REPOWN_CONFIG_DIR']; else process.env['REPOWN_CONFIG_DIR'] = saved;
    rmSync(registry, { recursive: true, force: true });
    box.dispose();
  } };
}

function record(at: Home, account: string, email: string): void {
  writeFileSync(join(at.registry, 'accounts.json'), JSON.stringify({ accounts: { [account]: { name: 'Octo Cat', email, host: 'github' } } }));
}

function repown(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, input: '', env: process.env, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

const localConfig = (at: Home): string => readFileSync(join(at.box.dir, '.git', 'config'), 'utf8');
const hook = (at: Home): string => join(at.box.dir, '.git', 'hooks', 'pre-push');

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
    assert.match(seen.stderr, /> repown use octocat/);
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

function shot(
  values: readonly (readonly [string, string | null])[],
  allowOwner: readonly string[],
  autoUpstream: string | null,
  guard: 'off' | 'on' | 'foreign',
): CloneSnapshot {
  return { values, allowOwner, autoUpstream, guard };
}

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

function sectionLines(stderr: string, start: string, end: string): string[] {
  const lines = stderr.split('\n');
  const from = lines.findIndex((line) => line.includes(start));
  assert.ok(from >= 0, start + '\n' + stderr);
  const rest = lines.slice(from + 1);
  const until = rest.findIndex((line) => line.includes(end));
  return (until < 0 ? rest : rest.slice(0, until)).map((line) => line.trim()).filter((line) => line.length > 0);
}

function expectedPin(box: Sandbox): string[] {
  const upstream = gitSupportsAutoUpstream(box.git('--version')) ? ['push.autoSetupRemote: (added) true'] : [];
  return [
    'user.name: Sandbox -> Octo Cat',
    'user.email: sandbox@example.invalid -> octocat@example.invalid',
    'user.useConfigOnly: (added) true',
    'repown.account: (added) octocat',
    'credential.https://github.com.username: (added) octocat',
    ...upstream,
    'push guard: off -> on',
  ];
}

function ghAuth(active: string, logins: readonly string[]): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: ok({ accounts: logins.map((login) => ({ login, active: login === active })), active }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

const WAIT_CHILD = 'const fs=require("fs");fs.writeFileSync(process.argv[1],"up");' +
  'const stop=process.argv[1]+".stop";' +
  'const wait=()=>{if(fs.existsSync(stop))process.exit(0);else setTimeout(wait,15)};wait()';

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

async function plainLead(box: Sandbox): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = plainPrompter({ input, output });
  input.end();
  const code = await runSetup(
    { positional: [], flags: new Map([['cwd', box.dir]]) },
    { interactive: true, prompter, lead: SETUP_NOTE },
  );
  assert.equal(code, 130, shown);
  return shown;
}

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

function guarded(at: Home): { positional: readonly string[]; flags: Map<string, string | boolean> } {
  const flags = new Map<string, string | boolean>([['cwd', at.box.dir], ['guard', true], ['no-input', true]]);
  return { positional: ['octocat'], flags };
}

async function holdInherit(): Promise<() => Promise<void>> {
  const marker = join(tmpdir(), 'repown-hold-' + process.pid);
  const stop = marker + '.stop';
  rmSync(marker, { force: true });
  rmSync(stop, { force: true });
  const pending = inherit(process.execPath, ['-e', WAIT_CHILD, marker]);
  const release = (): Promise<void> => releaseInherit(pending, marker, stop);
  try {
    await untilUp(marker);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

async function untilUp(marker: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(marker)) {
    if (Date.now() - started > 5_000) throw new Error('child did not start');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(handingOver(), true);
}

async function releaseInherit(pending: Promise<unknown>, marker: string, stop: string): Promise<void> {
  writeFileSync(stop, 'x');
  await pending;
  rmSync(marker, { force: true });
  rmSync(stop, { force: true });
}

function captureStep(onFirst: () => void): { text: () => string; begin: () => void; end: () => void } {
  let stderr = '';
  let emitted = false;
  const write = process.stderr.write;
  const begin = (): void => {
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const text = String(chunk);
      stderr += text;
      if (!emitted && text.includes('step 1 of')) { emitted = true; onFirst(); }
      return true;
    }) as typeof process.stderr.write;
  };
  return { text: () => stderr, begin, end: () => { process.stderr.write = write; } };
}

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

describe('repown setup: repoint and fetch, in a real clone', () => {
  let at: Home;
  beforeEach(() => { at = home(); record(at, 'octocat', 'octocat@example.invalid'); });
  afterEach(() => at.dispose());

  /** A bare origin holding the first commit, never fetched here (no tracking refs), then a commit by another address. */
  const unfetchedOrigin = (): string => {
    const path = join(at.box.dir, '..', 'origin.git');
    at.box.git('init', '-q', '--bare', path);
    at.box.git('remote', 'add', 'origin', path);
    at.box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    at.box.git('update-ref', '-d', 'refs/remotes/origin/main');
    at.box.git('-c', 'user.name=Someone', '-c', 'user.email=old@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'theirs');
    return path;
  };
  const tracking = (): string => at.box.git('for-each-ref', 'refs/remotes/origin/');

  test('--fetch fetches the destination first; --no-input without it does not', () => {
    unfetchedOrigin();
    assert.equal(repown(['setup', 'octocat', '--no-input'], at.box.dir).status, 0);
    assert.equal(tracking(), '', 'no fetch unless asked');
    at.box.git('config', '--local', '--unset', 'repown.account');
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /step 1 of \d: Fetch origin/);
    assert.match(run.stderr, /> git fetch origin/);
    assert.notEqual(tracking(), '');
  });

  test('a failed fetch warns, the rest of the plan runs, and the destination stays unknown', () => {
    rmSync(unfetchedOrigin(), { recursive: true, force: true });
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout + run.stderr, /WARN\s+fetch\s+could not fetch origin \(/);
    assert.match(localConfig(at), /account = octocat/);
    assert.equal(tracking(), '');
  });

  test('--fetch where nothing needs fetching says so and fetches nothing', () => {
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--fetch: /);
    assert.doesNotMatch(run.stderr, /> git fetch/);
  });

  test('the field case, re-authored: the closing line says done and the push passes the guard', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--guard', '--auto-upstream', '--reauthor', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /> repown reauthor --yes/);
    assert.match(run.stderr, /done: this clone is set up for octocat/);
    assert.equal(at.box.git('log', '-1', '--format=%ae|%ce'), 'octocat@example.invalid|octocat@example.invalid');
    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: at.box.dir, encoding: 'utf8', env: process.env });
    assert.equal(push.status, 0, push.stderr);
  });

  test('the field case, not re-authored: the closing line names the commits the guard will refuse', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--guard', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /repown reauthor/);
    assert.match(run.stderr, /set up for octocat; the next push will fail: 1 commit by another address/);
    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: at.box.dir, encoding: 'utf8', env: process.env });
    assert.notEqual(push.status, 0, 'the guard refuses it');
  });

  test('the field case with the guard left off: done, and the commits named as a warning', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--auto-upstream', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /done: this clone is set up for octocat$/m);
    assert.match(run.stderr, /1 commit on main not on any remote is by old@example\.invalid; the guard is off, so it pushes as it is/);
  });

  test('--reauthor with nothing by another address says so and rewrites nothing', () => {
    const path = join(at.box.dir, '..', 'origin.git');
    at.box.git('init', '-q', '--bare', path);
    at.box.git('remote', 'add', 'origin', path);
    at.box.git('push', '-q', '-u', 'origin', 'HEAD:main');
    const before = at.box.git('rev-parse', 'HEAD');
    const run = repown(['setup', 'octocat', '--reauthor', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--reauthor: /);
    assert.equal(at.box.git('rev-parse', 'HEAD'), before);
  });

  test('--repoint points the branch back at its remote, and nothing prints the URL', () => {
    at.box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    at.box.git('config', 'branch.main.remote', 'https://octocat:ghp_secret@github.com/octocat/project.git');
    const kept = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(at.box.git('config', 'branch.main.remote'), 'https://octocat:ghp_secret@github.com/octocat/project.git', 'not without --repoint');
    assert.doesNotMatch(kept.stdout + kept.stderr, /ghp_secret/);
    const run = repown(['setup', 'octocat', '--repoint', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(at.box.git('config', 'branch.main.remote'), 'origin');
    assert.match(run.stderr, /> git config --local branch\.main\.remote origin/);
    assert.match(run.stderr, /branch\.main\.remote: \(a URL\) -> origin/);
    assert.doesNotMatch(run.stdout + run.stderr, /ghp_secret|octocat:/);
  });
});
