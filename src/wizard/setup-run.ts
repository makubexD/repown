// `repown setup` from start to finish: turn flags into answers, check them, ask for
// the rest (or not, with --no-input), and run the commands the review showed --
// the same `run()` each command's own parser dispatches to, so there is one code
// path, not a wizard's copy of it.
//
// Nothing is written before the commands run. Cancelling exits 130, declining 1.

import { ghAdvice } from '../commands/status.ts';
import { ok, err, type Result } from '../core/result.ts';
import type { Git } from '../core/git.ts';
import { inspectAuth, type AuthState } from '../core/inspect.ts';
import { flagBool, flagString, gitFor, parseArgs, type Args } from '../ui/args.ts';
import { specFor, type Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';
import { useColour } from '../ui/format.ts';
import useCommand, { NEXT_GUARD } from '../commands/use.ts';
import fixCommand from '../commands/fix.ts';
import guardGroup from '../commands/guard.ts';
import accountsGroup from '../commands/accounts.ts';
import { wizard, refusedGiven, type Answers, type Prompter } from './engine.ts';
import { setupFlow, planCommands, formatCommand, missingFlags, printable, NEW_ACCOUNT, type PlannedCommand, type SetupContext } from './setup-flow.ts';
import { readContext, readRegistry, type ReadOptions } from './setup-context.ts';
import { plainPrompter } from './plain.ts';

export interface SetupDeps {
  /** The prompter to ask with; the real one is chosen when absent. */
  readonly prompter?: Prompter;
  /** stdin and stderr are both terminals. */
  readonly interactive: boolean;
  /** Tests pass a spy. Production leaves it unset, and the provider classifies. */
  readonly accountKind?: ReadOptions['accountKind'];
  /** Re-read after the steps. Tests pass a fake; production uses inspectAuth. */
  readonly auth?: ReadAuth;
}

const CANCELLED = 130;

export async function runSetup(args: Args, deps: SetupDeps): Promise<number> {
  const registry = await readRegistry();
  if (!registry.ok) { out.fail('setup', registry.error); return 1; }
  const given = givenFrom(args, registry.value.accounts);
  if (!given.ok) return usage(given.error);
  const unattended = flagBool(args, 'no-input');
  if (!deps.interactive && !unattended) return needsTerminal(given.value, registry.value.accounts);

  const git = gitFor(args);
  if (!(await git.isRepo())) {
    out.fail('setup', 'Not a git repository: ' + git.cwd);
    out.detail('run it inside a clone: cd path/to/repo, then repown setup');
    return 1;
  }
  const prompter = unattended ? null : deps.prompter ?? await choosePrompter();
  try {
    return await continueSetup({
      args, git, given: given.value, prompter, accountKind: deps.accountKind, readAuth: deps.auth ?? inspectAuth,
    });
  } finally {
    prompter?.close();
  }
}

interface Setup {
  readonly args: Args;
  readonly git: Git;
  readonly given: Answers;
  /** Null with --no-input: nothing is asked. */
  readonly prompter: Prompter | null;
  readonly accountKind?: ReadOptions['accountKind'];
  readonly readAuth: ReadAuth;
}

async function continueSetup({ args, git, given, prompter, accountKind, readAuth }: Setup): Promise<number> {
  prompter?.intro?.('repown setup');
  prompter?.busy?.('Reading this clone and this machine');
  const ctx = await readContext(git, flagString(args, 'cwd'), contextOptions(prompter, accountKind));
  if (!ctx.ok) { out.fail('setup', ctx.error); return 1; }
  const answers = checkAgainst(given, ctx.value, flagString(args, 'allow-owner'));
  if (!answers.ok) return answers.error;
  if (!prompter) return runUnattended(answers.value, ctx.value, git, readAuth);
  return runGuided(answers.value, ctx.value, { git, prompter, readAuth });
}

function contextOptions(prompter: Prompter | null, accountKind: ReadOptions['accountKind']): ReadOptions {
  const classifyOwner = prompter !== null;
  return accountKind ? { classifyOwner, accountKind } : { classifyOwner };
}

// ------------------------------------------------------------ flags -> answers

type Recorded = Readonly<Record<string, unknown>>;

/** Flags as the answers they stand for. An account that isn't recorded is a new one. */
function givenFrom(args: Args, recorded: Recorded): Result<Answers> {
  const answers: Answers = {};
  const account = args.positional[0];
  const known = account !== undefined && Object.hasOwn(recorded, account);
  if (account !== undefined) Object.assign(answers, known ? { account } : { account: NEW_ACCOUNT, newAccount: account });
  // --name, --email and --host describe a new account: with them, the account is a new one.
  const describesNew = ['name', 'email', 'host'].some((key) => flagString(args, key) !== null);
  if (account === undefined && describesNew) answers['account'] = NEW_ACCOUNT;
  for (const key of ['name', 'email', 'host']) {
    const value = flagString(args, key);
    if (value !== null) answers[key] = value;
  }
  if (known && ['name', 'email', 'host'].some((key) => answers[key] !== undefined)) {
    return err('"' + account + '" is already recorded: --name, --email and --host describe a new account' +
               '\nto change it, record it again: repown accounts add ' + account + ' --name "..." --email "..."');
  }
  for (const key of ['gh', 'guard', 'fix'] as const) if (flagBool(args, key)) answers[key] = true;
  if (flagString(args, 'allow-owner') !== null) answers['allowOwner'] = true;
  if (flagBool(args, 'no-input')) for (const key of ['gh', 'allowOwner', 'guard', 'fix']) answers[key] ??= false;
  return ok(answers);
}

function usage(message: string): number {
  const [first, ...rest] = message.split('\n');
  out.fail('setup', first ?? message);
  for (const line of rest) out.detail(line);
  out.detail('run `repown help setup` for usage');
  return 2;
}

function needsTerminal(given: Answers, recorded: Recorded): number {
  out.fail('setup', 'needs a terminal to ask its questions.');
  out.detail('without one, give the answers as flags and add --no-input:');
  out.detail('  repown setup <account> [--name "..." --email "..."] [--gh] [--allow-owner <owner>] [--guard] [--fix] --no-input');
  const missing = missingFlags(given, recorded);
  if (missing.length > 0) out.detail('still needed: ' + missing.join(', '));
  return 2;
}

/** Flags checked against this clone: the same rules a typed answer meets, before anything is written. */
function checkAgainst(given: Answers, ctx: SetupContext, allowOwner: string | null): Result<Answers, number> {
  const answers = { ...given };
  if (allowOwner !== null) {
    if (!ctx.owner || allowOwner.toLowerCase() !== ctx.owner.toLowerCase()) {
      return err(usage(printable('--allow-owner ' + allowOwner + ': origin belongs to ' + (ctx.owner ? '"' + ctx.owner + '"' : 'no owner repown can read'))));
    }
  }
  const refused = refusedGiven(setupFlow(ctx), answers);
  if (refused.length > 0) return err(usage(refused.join('\n')));
  if (answers['guard'] === true && (ctx.guard === 'foreign' || ctx.redirected)) {
    out.fail('setup', '--guard: ' + (ctx.redirected ? 'core.hooksPath points hooks elsewhere' : 'another tool owns the pre-push hook') + '; nothing was changed');
    out.detail('see: repown guard status');
    return err(1);
  }
  if (answers['fix'] === true && ctx.fixLines === null) {
    out.detail('--fix: gh is not the credential helper for this clone, so there is nothing to undo');
    answers['fix'] = false;
  }
  return ok(answers);
}

// ------------------------------------------------------------------- the runs

async function runUnattended(answers: Answers, ctx: SetupContext, git: Git, readAuth: ReadAuth): Promise<number> {
  const missing = missingFlags(answers, ctx.recorded);
  if (missing.length > 0) return usage('--no-input, but still needed: ' + missing.join(', '));
  return execute(planCommands(answers, ctx), git, readAuth);
}

type ReadAuth = (git: Git, probeUrl?: string) => Promise<AuthState>;

interface Guided {
  readonly git: Git;
  readonly prompter: Prompter;
  readonly readAuth: ReadAuth;
}

async function runGuided(given: Answers, ctx: SetupContext, { git, prompter, readAuth }: Guided): Promise<number> {
  const outcome = await wizard(setupFlow(ctx), ctx, given, prompter);
  if (outcome.status === 'done') { prompter.outro?.('Nothing changed: this clone was already set up'); return 0; }
  if (outcome.status !== 'run') return stoppedBefore(outcome.status, prompter);
  prompter.outro?.('Running the commands');
  // The commands own the terminal from here: none of them may find it held.
  prompter.close();
  return execute(planCommands(outcome.answers, ctx), git, readAuth);
}

/** One closing line: what happened, that nothing changed, and how to start again. */
function stoppedBefore(status: 'cancelled' | 'declined', prompter: Prompter): number {
  const cancelled = status === 'cancelled';
  const message = (cancelled ? 'Cancelled' : 'Declined') + ': nothing was changed. Run repown setup again any time.';
  if (prompter.outro) prompter.outro(message, cancelled);
  else out.warn('setup', message);
  return cancelled ? CANCELLED : 1;
}

/**
 * @clack/prompts when colour is on for stderr and the terminal can draw it; the plain
 * prompter otherwise, and whenever the optional dependency is absent or fails to load
 * (an older Node skips installing it, ADR-016) -- said once, then carried on.
 */
async function choosePrompter(): Promise<Prompter> {
  const streams = { input: process.stdin, output: process.stderr };
  if (!useColour(process.stderr) || process.env['TERM'] === 'dumb') return plainPrompter(streams);
  try {
    return (await import('./clack.ts')).clackPrompter(streams);
  } catch (cause) {
    out.detail('plain prompts: the richer prompter could not load (' + (cause instanceof Error ? cause.message : String(cause)) + ')');
    return plainPrompter(streams);
  }
}

/**
 * Runs the plan in order and stops at the first failure. Ctrl-C while a command runs
 * reaches the git and gh processes it has started; the command itself finishes what it
 * is doing, and nothing after it runs (exit 130).
 */
async function execute(plan: readonly PlannedCommand[], git: Git, readAuth: ReadAuth): Promise<number> {
  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    for (const [index, planned] of plan.entries()) {
      // A blank line between steps, so each command's output reads as its own.
      if (index > 0) process.stderr.write('\n');
      out.detail('step ' + (index + 1) + ' of ' + plan.length + ': ' + printable(planned.what));
      out.detail('> ' + formatCommand(planned.argv));
      const guardNext = plan[index + 1]?.argv[0] === 'guard';
      const code = await (guardNext ? withoutLine(NEXT_GUARD, () => runOne(planned.argv, git)) : runOne(planned.argv, git));
      if (code !== 0 || interrupted) return stopped(plan.slice(index + 1), interrupted ? CANCELLED : code);
    }
  } finally {
    process.off('SIGINT', onInterrupt);
  }
  await finishRun(plan, git, readAuth);
  return 0;
}

async function finishRun(plan: readonly PlannedCommand[], git: Git, readAuth: ReadAuth): Promise<void> {
  finished(plan);
  const left = await ghLeftover(plan, git, readAuth);
  if (left) out.detail(left);
}

async function ghLeftover(plan: readonly PlannedCommand[], git: Git, readAuth: ReadAuth): Promise<string | null> {
  const account = plan.find((item) => item.argv[0] === 'use')?.argv.at(-1);
  if (!account) return null;
  const advice = ghAdvice(account, await readAuth(git));
  return advice ? 'still to do: ' + advice.detail.replace(/^fix: /, '') : null;
}

/**
 * The account the plan pinned, and where to look next. On stderr, like the step lines:
 * stdout carries only what the commands themselves print.
 */
function finished(plan: readonly PlannedCommand[]): void {
  process.stderr.write('\n');
  const pinned = plan.find((planned) => planned.argv[0] === 'use')?.argv.at(-1) ?? '';
  out.detail('done: this clone is set up for ' + printable(pinned));
  out.detail('check it any time: repown (this clone), repown doctor (this machine)');
}

function stopped(remaining: readonly PlannedCommand[], code: number): number {
  out.fail('setup', code === CANCELLED ? 'interrupted' : 'stopped: that command exited ' + code);
  if (remaining.length > 0) out.detail('not run:');
  for (const planned of remaining) out.detail('  ' + formatCommand(planned.argv));
  return code;
}

/**
 * Runs `run` with one line of its stdout -- and the blank line before it -- left out:
 * `use`'s "Next: repown guard on" when the plan's next step does just that. `use`
 * itself is unchanged; run on its own, it still says it.
 */
async function withoutLine<T>(hidden: string, run: () => Promise<T>): Promise<T> {
  const write = process.stdout.write;
  let held = '';
  const pass = (text: string): boolean => write.call(process.stdout, text);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    const text = String(chunk);
    if (text === '\n' && !held) { held = text; return true; }
    const shown = text === hidden + '\n' ? '' : held + text;
    held = '';
    return shown ? pass(shown) : true;
  }) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = write;
    if (held) pass(held);
  }
}

// -------------------------------------------------------- one planned command

async function runOne(argv: readonly string[], git: Git): Promise<number> {
  if (argv[0] === 'git') return allowOwner(argv.at(-1)!, git);
  const [command, rest] = commandFor(argv);
  const parsed = parseArgs(rest, specFor(command));
  if (!parsed.ok) { out.fail('setup', 'could not run ' + formatCommand(argv) + ': ' + parsed.error); return 2; }
  return command.run(parsed.value);
}

/** The Command a planned argv names, and the arguments after its name. */
function commandFor(argv: readonly string[]): [Command, readonly string[]] {
  if (argv[0] === 'use') return [useCommand, argv.slice(1)];
  if (argv[0] === 'fix') return [fixCommand, argv.slice(1)];
  if (argv[0] === 'guard') return [guardGroup.actions['on']!, argv.slice(2)];
  return [accountsGroup.actions['add']!, argv.slice(2)];
}

/** ADR-004's line, run through the Git wrapper: repo-local, and only if not there already. */
async function allowOwner(owner: string, git: Git): Promise<number> {
  const present = await git.getAllConfig('repown.allowOwner', 'local');
  if (present.some((value) => value.toLowerCase() === owner.toLowerCase())) {
    out.pass('origin', printable(owner) + ' is already allowed in this clone');
    return 0;
  }
  if (!(await git.addConfig('repown.allowOwner', owner, 'local'))) {
    out.fail('origin', 'could not write repown.allowOwner ' + printable(owner));
    return 1;
  }
  out.pass('origin', 'pushes to ' + printable(owner) + ' allowed in this clone');
  return 0;
}
