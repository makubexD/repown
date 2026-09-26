// `repown setup` from start to finish: turn flags into answers, check them, ask for
// the rest (or not, with --no-input), and run the commands the review showed --
// the same `run()` each command's own parser dispatches to, so there is one code
// path, not a wizard's copy of it.
//
// Nothing is written before the commands run. Cancelling exits 130, declining 1.

import { ok, err, type Result } from '../core/result.ts';
import type { Git } from '../core/git.ts';
import { flagBool, flagString, gitFor, parseArgs, type Args } from '../ui/args.ts';
import { specFor, type Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';
import { useColour } from '../ui/format.ts';
import useCommand from '../commands/use.ts';
import fixCommand from '../commands/fix.ts';
import guardGroup from '../commands/guard.ts';
import accountsGroup from '../commands/accounts.ts';
import { wizard, refusedGiven, type Answers, type Prompter } from './engine.ts';
import { setupFlow, planCommands, formatCommand, missingFlags, printable, NEW_ACCOUNT, type PlannedCommand, type SetupContext } from './setup-flow.ts';
import { readContext, readRegistry } from './setup-context.ts';
import { plainPrompter } from './plain.ts';

export interface SetupDeps {
  /** The prompter to ask with; the real one is chosen when absent. */
  readonly prompter?: Prompter;
  /** stdin and stderr are both terminals. */
  readonly interactive: boolean;
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
  if (!(await git.isRepo())) { out.fail('setup', 'Not a git repository: ' + git.cwd); return 1; }
  const prompter = unattended ? null : deps.prompter ?? await choosePrompter();
  try {
    return await continueSetup({ args, git, given: given.value, prompter });
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
}

async function continueSetup({ args, git, given, prompter }: Setup): Promise<number> {
  prompter?.intro?.('repown setup');
  const done = prompter?.busy?.('Reading this clone and this machine');
  const ctx = await readContext(git, flagString(args, 'cwd'));
  done?.(ctx.ok ? 'Read this clone and this machine' : 'Could not read everything');
  if (!ctx.ok) { out.fail('setup', ctx.error); return 1; }
  const answers = checkAgainst(given, ctx.value, flagString(args, 'allow-owner'));
  if (!answers.ok) return answers.error;
  if (!prompter) return runUnattended(answers.value, ctx.value, git);
  return runGuided(answers.value, ctx.value, { git, prompter });
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

async function runUnattended(answers: Answers, ctx: SetupContext, git: Git): Promise<number> {
  const missing = missingFlags(answers, ctx.recorded);
  if (missing.length > 0) return usage('--no-input, but still needed: ' + missing.join(', '));
  return execute(planCommands(answers, ctx), git);
}

interface Guided {
  readonly git: Git;
  readonly prompter: Prompter;
}

async function runGuided(given: Answers, ctx: SetupContext, { git, prompter }: Guided): Promise<number> {
  const outcome = await wizard(setupFlow(ctx), ctx, given, prompter);
  if (outcome.status === 'done') { prompter.outro?.('Nothing changed: this clone was already set up'); return 0; }
  if (outcome.status !== 'run') return stoppedBefore(outcome.status, prompter);
  prompter.outro?.('Running the commands');
  // The commands own the terminal from here: none of them may find it held.
  prompter.close();
  return execute(planCommands(outcome.answers, ctx), git);
}

function stoppedBefore(status: 'cancelled' | 'declined', prompter: Prompter): number {
  prompter.outro?.(status === 'cancelled' ? 'Cancelled' : 'Declined');
  out.warn('setup', status + '; nothing was changed.');
  out.detail('run repown setup again any time');
  return status === 'cancelled' ? CANCELLED : 1;
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
async function execute(plan: readonly PlannedCommand[], git: Git): Promise<number> {
  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    for (const [index, planned] of plan.entries()) {
      out.detail('step ' + (index + 1) + ' of ' + plan.length + ': ' + printable(planned.what));
      out.detail('> ' + formatCommand(planned.argv));
      const code = await runOne(planned.argv, git);
      if (code !== 0 || interrupted) return stopped(plan.slice(index + 1), interrupted ? CANCELLED : code);
    }
  } finally {
    process.off('SIGINT', onInterrupt);
  }
  finished(plan);
  return 0;
}

/** The account the plan pinned, and where to look next. */
function finished(plan: readonly PlannedCommand[]): void {
  const pinned = plan.find((planned) => planned.argv[0] === 'use')?.argv.at(-1) ?? '';
  out.line();
  out.line('  done: this clone is set up for ' + printable(pinned));
  out.line('  check it any time: repown    this machine: repown doctor');
}

function stopped(remaining: readonly PlannedCommand[], code: number): number {
  out.fail('setup', code === CANCELLED ? 'interrupted' : 'stopped: that command exited ' + code);
  if (remaining.length > 0) out.detail('not run:');
  for (const planned of remaining) out.detail('  ' + formatCommand(planned.argv));
  return code;
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
