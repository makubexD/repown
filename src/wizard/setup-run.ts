// `repown setup` from start to finish: turn flags into answers, check them, ask for
// the rest (or not, with --no-input), and run the commands the review showed --
// the same `run()` each command's own parser dispatches to, so there is one code
// path, not a wizard's copy of it.
//
// Nothing is written before the commands run. Cancelling exits 130, declining 1.

import { ghAdvice } from '../commands/status.ts';
import { handingOver } from '../core/exec.ts';
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
import { wizard, refusedGiven, CANCEL, type Answers, type Prompter, type StepChoice } from './engine.ts';
import { setupFlow, planCommands, formatCommand, briefOf, missingFlags, printable, dropFixPrefix, NEW_ACCOUNT, type PlannedCommand, type SetupContext } from './setup-flow.ts';
import { cloneChangeLines, machineChangeLines, readCloneSnapshot, type CloneSnapshot } from './setup-changes.ts';
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
  applyConfirms(args, answers);
  return modeOf(args, answers);
}

/** `--step-by-step` asks every question. An account on the command line uses Recommended and skips the question. */
function modeOf(args: Args, answers: Answers): Result<Answers> {
  if (flagBool(args, 'step-by-step') && flagBool(args, 'no-input')) return err('--step-by-step needs a terminal to ask');
  if (flagBool(args, 'step-by-step')) answers['mode'] = 'step';
  else if (args.positional[0] !== undefined) answers['mode'] = 'recommended';
  return ok(answers);
}

const CONFIRM_FLAGS = ['gh', 'guard', 'fix'] as const;
const CONFIRM_DEFAULTS = ['gh', 'allowOwner', 'guard', 'fix', 'upstream'] as const;

/** A passed flag is Yes. With --no-input, a confirm that was not passed is No, not Recommended's Yes. */
function applyConfirms(args: Args, answers: Answers): void {
  for (const key of CONFIRM_FLAGS) if (flagBool(args, key)) answers[key] = true;
  if (flagBool(args, 'auto-upstream')) answers['upstream'] = true;
  if (flagString(args, 'allow-owner') !== null) answers['allowOwner'] = true;
  if (flagBool(args, 'no-input')) for (const key of CONFIRM_DEFAULTS) answers[key] ??= false;
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
  out.detail('  repown setup <account> [--name "..." --email "..."] [--gh] [--allow-owner <owner>] [--guard] [--auto-upstream] [--fix] --no-input');
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
  return execute(planCommands(answers, ctx), runState(git, readAuth, ctx));
}

type ReadAuth = (git: Git, probeUrl?: string) => Promise<AuthState>;

interface Guided {
  readonly git: Git;
  readonly prompter: Prompter;
  readonly readAuth: ReadAuth;
}

async function runGuided(given: Answers, ctx: SetupContext, guided: Guided): Promise<number> {
  const outcome = await wizard(setupFlow(ctx), ctx, given, guided.prompter);
  if (outcome.status === 'done') { guided.prompter.outro?.('Nothing changed: this clone was already set up'); return 0; }
  if (outcome.status !== 'run') return stoppedBefore(outcome.status, guided.prompter);
  return runAccepted(outcome.answers, ctx, guided);
}

async function runAccepted(answers: Answers, ctx: SetupContext, { git, prompter, readAuth }: Guided): Promise<number> {
  prompter.outro?.('Running the commands');
  const confirm = gateFor(prompter, answers, ctx);
  // Recommended hands the terminal over now. Step by step keeps it for each question.
  if (!confirm) prompter.close();
  const state = runState(git, readAuth, ctx);
  const code = await execute(planCommands(answers, ctx), confirm ? { ...state, confirm } : state);
  if (confirm) prompter.close();
  return code;
}

type Confirm = (planned: PlannedCommand) => Promise<StepChoice | typeof CANCEL>;

function gateFor(prompter: Prompter, answers: Answers, ctx: SetupContext): Confirm | undefined {
  if (answers['mode'] !== 'step') return undefined;
  return (planned) => askStep(prompter, planned, answers, ctx);
}

async function askStep(prompter: Prompter, planned: PlannedCommand, answers: Answers, ctx: SetupContext): Promise<StepChoice | typeof CANCEL> {
  const choice = await prompter.confirmStep(briefOf(planned, answers, ctx));
  prompter.suspend?.();
  return choice;
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

interface RunState {
  readonly git: Git;
  readonly readAuth: ReadAuth;
  readonly confirm?: Confirm;
  readonly credentialKeys: readonly string[];
}

function runState(git: Git, readAuth: ReadAuth, ctx: SetupContext): RunState {
  return { git, readAuth, credentialKeys: ctx.credentialKeys };
}

/**
 * Runs the plan in order and stops at the first failure. In step-by-step mode each
 * step is confirmed first: Skip leaves it unrun, Stop (and Esc) runs nothing more.
 * Ctrl-C stops the steps that have not run (exit 130), except while an inherited
 * child is running: that Ctrl-C belongs to gh, and the remaining steps still run.
 * The clone is read before the first step and again after, including a stop or a failure.
 */
async function execute(plan: readonly PlannedCommand[], state: RunState): Promise<number> {
  const before = await readCloneSnapshot(state.git, state.credentialKeys);
  const ran = await walk(plan, state.git, state.confirm);
  await reportRun(before, ran, state);
  return ran.code ?? 0;
}

interface WalkResult {
  readonly done: readonly PlannedCommand[];
  readonly skipped: readonly PlannedCommand[];
  /** Null when the plan finished. A stop or a failed step is that exit code. */
  readonly code: number | null;
}

async function walk(plan: readonly PlannedCommand[], git: Git, confirm?: Confirm): Promise<WalkResult> {
  let interrupted = false;
  const onInterrupt = (): void => { if (!handingOver()) interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    return await eachStep(plan, git, confirm, () => interrupted);
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

async function eachStep(
  plan: readonly PlannedCommand[],
  git: Git,
  confirm: Confirm | undefined,
  interrupted: () => boolean,
): Promise<WalkResult> {
  const done: PlannedCommand[] = [];
  const skipped: PlannedCommand[] = [];
  for (const [index, planned] of plan.entries()) {
    const choice = await offer(plan, index, planned, confirm);
    const halted = await actOn(choice, { plan, index, git, interrupted, confirming: confirm !== undefined });
    if (halted !== null) return { done, skipped, code: halted };
    (choice === 'skip' ? skipped : done).push(planned);
  }
  return { done, skipped, code: null };
}

async function offer(
  plan: readonly PlannedCommand[],
  index: number,
  planned: PlannedCommand,
  confirm: Confirm | undefined,
): Promise<StepChoice | typeof CANCEL> {
  // A blank line between steps, so each command's output reads as its own.
  if (index > 0) process.stderr.write('\n');
  out.detail('step ' + (index + 1) + ' of ' + plan.length + ': ' + printable(planned.what));
  if (!confirm) {
    out.detail('> ' + formatCommand(planned.argv));
    return 'yes';
  }
  return confirm(planned);
}

interface Act {
  readonly plan: readonly PlannedCommand[];
  readonly index: number;
  readonly git: Git;
  readonly interrupted: () => boolean;
  readonly confirming: boolean;
}

async function actOn(choice: StepChoice | typeof CANCEL, at: Act): Promise<number | null> {
  if (choice === 'skip') return null;
  if (choice !== 'yes') return halt(at.plan.slice(at.index), CANCELLED, 'stopped');
  const code = await runPlanned(at.plan[at.index]!, at.git, hideGuard(at));
  if (code === 0 && !at.interrupted()) return null;
  return halt(at.plan.slice(at.index + 1), at.interrupted() ? CANCELLED : code);
}

function hideGuard(at: Act): boolean {
  return !at.confirming && at.plan[at.index + 1]?.argv[0] === 'guard';
}

function runPlanned(planned: PlannedCommand, git: Git, hideNext: boolean): Promise<number> {
  const run = (): Promise<number> => runOne(planned.argv, git);
  return hideNext ? withoutLine(NEXT_GUARD, run) : run();
}

function halt(remaining: readonly PlannedCommand[], code: number, why?: string): number {
  out.fail('setup', why ?? (code === CANCELLED ? 'interrupted' : 'stopped: that command exited ' + code));
  if (remaining.length > 0) out.detail('not run:');
  for (const planned of remaining) out.detail('  ' + formatCommand(planned.argv));
  return code;
}

/** On stderr, like the step lines: stdout carries only what the commands themselves print. */
async function reportRun(before: CloneSnapshot, ran: WalkResult, state: RunState): Promise<void> {
  if (ran.code === null) announce(ran.done, ran.skipped);
  await printClone(before, state);
  const auth = wantsAuth(ran) ? await state.readAuth(state.git) : null;
  printMachine(ran.done, auth);
  if (ran.code === null) closeRun(ran.done, auth);
}

function announce(done: readonly PlannedCommand[], skipped: readonly PlannedCommand[]): void {
  process.stderr.write('\n');
  const pinned = done.find((planned) => planned.argv[0] === 'use')?.argv.at(-1);
  if (pinned) out.detail('done: this clone is set up for ' + printable(pinned));
  for (const planned of skipped) out.detail('skipped: ' + printable(planned.what));
}

async function printClone(before: CloneSnapshot, state: RunState): Promise<void> {
  const lines = cloneChangeLines(before, await readCloneSnapshot(state.git, state.credentialKeys));
  if (lines.length === 0) { out.detail('nothing changed in this clone'); return; }
  out.detail('changed in this clone:');
  for (const line of lines) out.detail(printable(line));
}

/** Success re-reads gh for the optional line. A later failure still does, once, when `--gh` already ran. */
function wantsAuth(ran: WalkResult): boolean {
  const use = ran.done.find((item) => item.argv[0] === 'use');
  if (!use) return false;
  return ran.code === null || use.argv.includes('--gh');
}

function printMachine(done: readonly PlannedCommand[], auth: AuthState | null): void {
  const lines = machineChangeLines(addedAccount(done), activeGh(done, auth));
  if (lines.length === 0) return;
  out.detail('changed on this machine:');
  for (const line of lines) out.detail(printable(line));
}

function addedAccount(done: readonly PlannedCommand[]): string | null {
  return done.find((item) => item.argv[0] === 'accounts')?.argv.at(-1) ?? null;
}

function activeGh(done: readonly PlannedCommand[], auth: AuthState | null): string | null {
  const account = done.find((item) => item.argv[0] === 'use' && item.argv.includes('--gh'))?.argv.at(-1);
  const active = auth?.gh.ok ? auth.gh.value.active : null;
  if (!account || active === null) return null;
  return active.toLowerCase() === account.toLowerCase() ? account : null;
}

function closeRun(done: readonly PlannedCommand[], auth: AuthState | null): void {
  out.detail('check it any time: repown status (this clone), repown doctor (this machine)');
  const left = ghLeftover(done, auth);
  if (left) out.detail(left);
}

function ghLeftover(plan: readonly PlannedCommand[], auth: AuthState | null): string | null {
  const account = plan.find((item) => item.argv[0] === 'use')?.argv.at(-1);
  if (!account || !auth) return null;
  const advice = ghAdvice(account, auth);
  return advice ? 'optional, only if you use gh here: ' + dropFixPrefix(advice.detail) : null;
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
  if (argv[0] === 'git') return gitLine(argv, git);
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

/** A planned git line. Both are repo-local; neither shells out past the Git wrapper. */
function gitLine(argv: readonly string[], git: Git): Promise<number> {
  if (argv.includes('push.autoSetupRemote')) return setAutoUpstream(git);
  return allowOwner(argv.at(-1)!, git);
}

/** push.autoSetupRemote, in this clone only, and only when it does not already say true. */
async function setAutoUpstream(git: Git): Promise<number> {
  if (await git.getBoolConfig('push.autoSetupRemote', 'local') === true) {
    out.pass('upstream', 'push.autoSetupRemote is already set in this clone');
    return 0;
  }
  if (!(await git.setConfig('push.autoSetupRemote', 'true', 'local'))) {
    out.fail('upstream', 'could not write push.autoSetupRemote');
    return 1;
  }
  out.pass('upstream', 'branches without an upstream push without -u in this clone');
  return 0;
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
