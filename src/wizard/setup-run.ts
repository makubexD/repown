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
import useCommand from '../commands/use.ts';
import fixCommand from '../commands/fix.ts';
import guardGroup from '../commands/guard.ts';
import accountsGroup from '../commands/accounts.ts';
import { wizard, refusedGiven, type Answers, type Prompter } from './engine.ts';
import { setupFlow, planCommands, formatCommand, missingFlags, NEW_ACCOUNT, type PlannedCommand, type SetupContext } from './setup-flow.ts';
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
  const ctx = await readContext(git, flagString(args, 'cwd'));
  if (!ctx.ok) { out.fail('setup', ctx.error); return 1; }
  const answers = checkAgainst(given.value, ctx.value, flagString(args, 'allow-owner'));
  if (!answers.ok) return answers.error;
  return unattended ? runUnattended(answers.value, ctx.value, git) : runGuided(answers.value, ctx.value, { git, deps });
}

// ------------------------------------------------------------ flags -> answers

type Recorded = Readonly<Record<string, unknown>>;

/** Flags as the answers they stand for. An account that isn't recorded is a new one. */
function givenFrom(args: Args, recorded: Recorded): Result<Answers> {
  const answers: Answers = {};
  const account = args.positional[0];
  const known = account !== undefined && Object.hasOwn(recorded, account);
  if (account !== undefined) Object.assign(answers, known ? { account } : { account: NEW_ACCOUNT, newAccount: account });
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
      return err(usage('--allow-owner ' + allowOwner + ': origin belongs to ' + (ctx.owner ? '"' + ctx.owner + '"' : 'no owner repown can read')));
    }
  }
  const refused = refusedGiven(setupFlow(ctx), answers);
  if (refused.length > 0) return err(usage(refused.join('\n')));
  if (answers['guard'] === true && (ctx.guard === 'foreign' || ctx.redirected)) {
    out.fail('setup', '--guard: ' + (ctx.redirected ? 'core.hooksPath points hooks elsewhere' : 'another tool owns the pre-push hook') + '; nothing was changed');
    out.detail('see: repown guard status');
    return err(1);
  }
  if (answers['fix'] === true && ctx.fixLines === null) answers['fix'] = false;
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
  readonly deps: SetupDeps;
}

async function runGuided(given: Answers, ctx: SetupContext, { git, deps }: Guided): Promise<number> {
  const prompter = deps.prompter ?? choosePrompter();
  let outcome;
  try {
    outcome = await wizard(setupFlow(ctx), ctx, given, prompter);
  } finally {
    prompter.close();
  }
  if (outcome.status === 'cancelled') { out.warn('setup', 'cancelled; nothing was changed.'); return CANCELLED; }
  if (outcome.status === 'declined') { out.warn('setup', 'declined; nothing was changed.'); return 1; }
  return execute(planCommands(outcome.answers, ctx), git);
}

function choosePrompter(): Prompter {
  return plainPrompter({ input: process.stdin, output: process.stderr });
}

/**
 * Runs the plan in order and stops at the first failure. Ctrl-C while a command runs
 * reaches that command as it would if you had typed it; nothing after it runs.
 */
async function execute(plan: readonly PlannedCommand[], git: Git): Promise<number> {
  let interrupted = false;
  const onInterrupt = (): void => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    for (const [index, planned] of plan.entries()) {
      out.detail('> ' + formatCommand(planned.argv));
      const code = await runOne(planned.argv, git);
      if (code !== 0 || interrupted) return stopped(plan.slice(index + 1), interrupted ? CANCELLED : code);
    }
  } finally {
    process.off('SIGINT', onInterrupt);
  }
  out.line();
  out.line('  next: repown doctor    (what serves credentials on this machine)');
  return 0;
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
    out.pass('origin', owner + ' is already allowed in this clone');
    return 0;
  }
  if (!(await git.addConfig('repown.allowOwner', owner, 'local'))) {
    out.fail('origin', 'could not write repown.allowOwner ' + owner);
    return 1;
  }
  out.pass('origin', 'pushes to ' + owner + ' allowed in this clone');
  return 0;
}
