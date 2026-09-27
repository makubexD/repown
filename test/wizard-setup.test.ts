// `repown setup`: the flow (which steps, what they turn into) with a scripted
// prompter and a hand-built context, then the command itself -- in-process with a
// scripted prompter for the interactive paths, and spawned for the paths a script
// or CI would take. Every run happens in a sandbox (isolated git config, registry).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';
import { setupContext as context } from './setup-fixtures.ts';
import { ok, err } from '../src/core/result.ts';
import { wizard, BACK, CANCEL, type Answers, type Prompter, type Reply, type Review, type ReviewChoice } from '../src/wizard/engine.ts';
import { setupFlow, planCommands, formatCommand, missingFlags, printable, NEW_ACCOUNT, DETECTED_PREFIX, accountOf, isNew, type SetupContext } from '../src/wizard/setup-flow.ts';
import { runSetup } from '../src/wizard/setup-run.ts';
import { readContext } from '../src/wizard/setup-context.ts';
import { Git } from '../src/core/git.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

// ---------------------------------------------------------------- the flow

type Entry = readonly [string, Reply | ReviewChoice];

function scripted(script: Entry[]): Prompter & { readonly asked: string[]; readonly reviews: Review[] } {
  const queue = [...script];
  const next = (id: string): Reply | ReviewChoice => {
    const entry = queue.shift();
    assert.ok(entry, 'script ran out at ' + id);
    assert.equal(entry[0], id, 'the wizard asked ' + id + ', the script expected ' + entry[0]);
    return entry[1];
  };
  const asked: string[] = [];
  const reviews: Review[] = [];
  return {
    asked,
    reviews,
    ask: async (step) => { asked.push(step.id); return next(step.id) as Reply; },
    review: async (review) => { reviews.push(review); return next('review') as ReviewChoice; },
    pickStep: async () => next('pick') as string,
    note: () => {},
    close: () => {},
  };
}

async function answer(ctx: SetupContext, script: Entry[], given: Answers = {}): Promise<Answers> {
  const outcome = await wizard(setupFlow(ctx), ctx, given, scripted(script));
  assert.equal(outcome.status, 'run');
  return outcome.status === 'run' ? outcome.answers : {};
}

/** Every line of text a review shows. */
const textOf = (review: Review): string[] =>
  [review.title, ...review.headline, ...review.notes, ...review.steps.flatMap((step) => [step.what, step.command, ...step.detail])];

const argvOf = (answers: Answers, ctx: SetupContext): (readonly string[])[] =>
  planCommands(answers, ctx).map((command) => command.argv);

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
    await wizard(setupFlow(context()), context(), {}, { ...prompter, note: (message) => notes.push(message) });
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

  test('gh is offered only on GitHub, only for an account gh knows, and only when another is active', async () => {
    const gh = ok({ accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }], active: 'octo-work' });
    const answers = await answer(context({ gh }), [['account', 'octocat'], ['gh', true], ['guard', true], ['review', 'run']]);
    assert.deepEqual(argvOf(answers, context({ gh }))[0], ['use', '--gh', '--', 'octocat']);
    await answer(context({ gh, host: 'azdo', credentialPinned: false }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
    const other = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    await answer(context({ gh: other }), [['account', 'octocat'], ['guard', true], ['review', 'run']]);
  });

  test('fix is offered only when gh is the helper, defaults to No, and runs before use', async () => {
    const ctx = context({ fixLines: ['    global:  credential.https://github.com.helper'] });
    const prompter = scripted([['account', 'octocat'], ['guard', true], ['fix', true], ['review', 'run']]);
    let initial: unknown;
    const outcome = await wizard(setupFlow(ctx), ctx, {}, { ...prompter, ask: async (step, asked) => {
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
    const outcome = await wizard(setupFlow(ctx), ctx, {}, { ...prompter, ask: async (step, asked) => {
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
    assert.match(reviewOf({}).title, /already set up/);
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
    for (const step of setupFlow(context()).steps) assert.ok(step.hint.trim().length > 10, step.id + ' has no real hint');
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
});

function stepOf(ctx: SetupContext, id: string) {
  const found = setupFlow(ctx).steps.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
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
  box.git('commit', '-q', '--allow-empty', '-m', 'base');
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

  test('an origin that is not GitHub detects no accounts and does not classify the owner', async () => {
    at.box.git('remote', 'set-url', 'origin', 'https://dev.azure.com/octo-org/project/_git/repo');
    const ctx = await read();
    assert.equal(ctx.owner, 'octo-org');
    assert.equal(ctx.detected.length, 0);
    assert.equal(ctx.ownerIsUser, null);
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
    assert.match(run.stderr, /done: this clone is set up for octocat/);
    assert.match(run.stderr, /check it any time: repown/);
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
    assert.doesNotMatch(localConfig(at), /repown/);
  });
});

describe('repown setup, on a terminal (scripted)', () => {
  let at: Home;
  beforeEach(() => { at = home(); record(at, 'octocat', 'octocat@example.invalid'); });
  afterEach(() => at.dispose());

  const runWith = (prompter: Prompter): Promise<number> =>
    runSetup({ positional: [], flags: new Map([['cwd', at.box.dir]]) }, { prompter, interactive: true });
  const run = (script: Entry[]): Promise<number> => runWith(scripted(script));

  test('Run pins the clone and turns the guard on', async () => {
    assert.equal(await run([['account', 'octocat'], ['guard', true], ['review', 'run']]), 0);
    assert.match(localConfig(at), /account = octocat/);
    assert.ok(existsSync(hook(at)));
  });

  test('already set up: Done exits 0 and writes nothing; Apply again pins as before', async () => {
    const first = scripted([['account', 'octocat'], ['guard', false], ['review', 'run']]);
    assert.equal(await runWith(first), 0);
    assert.equal(first.reviews[0]!.settled, false, 'not set up before the first run');
    const before = localConfig(at);
    const again = scripted([['account', 'octocat'], ['guard', false], ['review', 'done']]);
    assert.equal(await runWith(again), 0);
    assert.equal(again.reviews[0]!.settled, true, 'the clone, read back from git, counts as set up');
    assert.equal(localConfig(at), before);
    assert.equal(await run([['account', 'octocat'], ['guard', false], ['review', 'run']]), 0);
    assert.equal(localConfig(at), before);
  });

  test('Decline exits 1 and writes nothing', async () => {
    const before = localConfig(at);
    assert.equal(await run([['account', 'octocat'], ['guard', true], ['review', 'decline']]), 1);
    assert.equal(localConfig(at), before);
    assert.equal(existsSync(hook(at)), false);
  });

  test('Decline and cancel each end with one line: nothing changed, and how to start again', async () => {
    const endings: [string, boolean | undefined][] = [];
    const closing = (script: Entry[]): Prompter => ({ ...scripted(script), outro: (message, cancelled) => { endings.push([message, cancelled]); } });
    assert.equal(await runWith(closing([['account', 'octocat'], ['guard', true], ['review', 'decline']])), 1);
    assert.equal(await runWith(closing([['account', CANCEL]])), 130);
    assert.deepEqual(endings, [
      ['Declined: nothing was changed. Run repown setup again any time.', false],
      ['Cancelled: nothing was changed. Run repown setup again any time.', true],
    ]);
  });

  test('Cancel at a step or at the review exits 130 and writes nothing', async () => {
    const before = localConfig(at);
    assert.equal(await run([['account', CANCEL]]), 130);
    assert.equal(await run([['account', 'octocat'], ['guard', true], ['review', CANCEL]]), 130);
    assert.equal(localConfig(at), before);
  });
});
