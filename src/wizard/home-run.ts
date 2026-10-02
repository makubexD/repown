// The start screen: a summary of this folder, then one menu. Each action prints
// the command it stands for and runs that command's own run(). Loaded only
// through the runner start.ts returns, so a typed command never imports it.
// Once fix, doctor or accounts add has run, failed or not, the screen opens again (ADR-028).
//
// Quit exits 0. Esc and Ctrl-C exit 130, the same cancel setup uses. Neither writes.

import fixCommand from '../commands/fix.ts';
import doctorCommand from '../commands/doctor.ts';
import accountsGroup from '../commands/accounts.ts';
import { COMMANDS } from '../program.ts';
import { parseArgs, type Args } from '../ui/args.ts';
import { specFor, type Command } from '../ui/command.ts';
import { loadEntries } from '../ui/dispatch.ts';
import * as out from '../ui/format.ts';
import { renderTopHelp } from '../ui/help.ts';
import { CANCEL, runFlow, type Pass, type Prompter } from './engine.ts';
import { readHome, type HomeState } from './home-context.ts';
import { BACK as HOME_BACK, MENU, commandFor, homeNote, listedClones, menuItems, summaryLines } from './home-flow.ts';
import { BACK_LABEL, BUSY, CANCELLED, QUIT, WHAT_NEXT, WHICH_CLONE, homeTitle } from './home-text.ts';
import { formatCommand, loginStep, newAccountOf, printable, profileSteps, signedInLogins, type AccountContext } from './setup-flow.ts';
import { Git } from '../core/git.ts';
import { inspectAuth } from '../core/inspect.ts';
import { COMMAND_MARK } from './review-text.ts';
import { suggester } from './setup-context.ts';
import { choosePrompter, runSetup } from './setup-run.ts';

const CANCELLED_CODE = 130;

export interface HomeRunDeps {
  /** The prompter to ask with. Production chooses the real one. */
  readonly prompter?: Prompter;
  readonly cwd?: string;
  /** Tests pass a fake read. Production reads this folder. */
  readonly read?: (cwd: string) => Promise<HomeState>;
  /** Tests pass a fake profile lookup. Production asks the host, once per login. */
  readonly suggest?: AccountContext['suggest'];
  /** Tests pass fixed sign-ins. Production reads gh and GCM once, when the name question first asks. */
  readonly signedIn?: AccountContext['signedIn'];
}

/** The account questions from the top. Back from the login returns to the menu, as `opening`. */
const FIRST_PASS: Pass = { answers: {}, start: 0, given: new Set(), history: [], toOpening: true, showOpening: false };

export async function runHome(deps: HomeRunDeps = {}): Promise<number> {
  const prompter = deps.prompter ?? await choosePrompter();
  try {
    return await openHome(prompter, deps);
  } finally {
    prompter.close();
  }
}

/** A machine-level action ran: open the start screen again, read afresh (ADR-028). */
const AGAIN = Symbol('again');

async function openHome(prompter: Prompter, deps: HomeRunDeps): Promise<number> {
  for (;;) {
    const code = await homeRound(prompter, deps);
    if (code !== AGAIN) return code;
  }
}

async function homeRound(prompter: Prompter, deps: HomeRunDeps): Promise<number | typeof AGAIN> {
  const cwd = deps.cwd ?? process.cwd();
  prompter.intro?.(homeTitle(printable(cwd)));
  prompter.busy?.(BUSY);
  const home = await (deps.read ?? readHome)(cwd);
  showLines(prompter, summaryLines(home));
  const note = homeNote(home);
  if (note) prompter.note(note);
  return chooseNext(prompter, home, deps);
}

async function chooseNext(prompter: Prompter, home: HomeState, deps: HomeRunDeps): Promise<number | typeof AGAIN> {
  for (;;) {
    const picked = await prompter.choose(WHAT_NEXT, menuItems(home));
    if (picked === CANCEL) return finish(prompter, CANCELLED, CANCELLED_CODE);
    const code = await dispatchChoice(picked, prompter, home, deps);
    if (code !== null) return code;
  }
}

/** Setup, help and Quit end the screen; once fix, doctor or accounts add has run, it comes back. */
async function dispatchChoice(picked: string, prompter: Prompter, home: HomeState, deps: HomeRunDeps): Promise<number | null | typeof AGAIN> {
  if (picked === MENU.quit) return finish(prompter, QUIT, 0);
  if (picked === MENU.help) return showTopHelp(prompter);
  if (picked === MENU.setup) return pickClone(prompter, home);
  if (picked === MENU.fix) return again(runOwn(prompter, fixCommand, [], commandFor({ kind: 'fix' })));
  if (picked === MENU.doctor) return again(runOwn(prompter, doctorCommand, [], commandFor({ kind: 'doctor' })));
  if (picked === MENU.account) return recordAccount(prompter, home, deps);
  return finish(prompter, QUIT, 0);
}

async function pickClone(prompter: Prompter, home: HomeState): Promise<number | null> {
  const list = listedClones(home);
  if (list.more) showLines(prompter, [list.more]);
  const options = [...list.clones, { value: HOME_BACK, label: BACK_LABEL }];
  const picked = await prompter.choose(WHICH_CLONE, options);
  if (picked === CANCEL) return finish(prompter, CANCELLED, CANCELLED_CODE);
  if (picked === HOME_BACK) return null;
  return runInClone(prompter, picked);
}

async function runInClone(prompter: Prompter, cwd: string): Promise<number> {
  const argv = commandFor({ kind: 'setup', path: cwd });
  handOver(prompter, argv);
  return runSetup(setupArgs(cwd), { interactive: true, prompter });
}

/**
 * Setup's own questions for a new account (login, host, name, email) in this frame,
 * then `accounts add` with every answer as a flag, so it has nothing left to ask.
 */
async function recordAccount(prompter: Prompter, home: HomeState, deps: HomeRunDeps): Promise<number | null | typeof AGAIN> {
  const ctx = accountContext(home, deps);
  const walk = await runFlow({ steps: [loginStep(ctx), ...profileSteps(ctx)] }, ctx, FIRST_PASS, prompter);
  if (walk.status === 'cancelled') return finish(prompter, CANCELLED, CANCELLED_CODE);
  if (walk.status === 'opening') return null;
  const argv = commandFor({ kind: 'account', ...newAccountOf(walk.answers, ctx) });
  return again(runOwn(prompter, accountsGroup.actions['add']!, argv.slice(2), argv));
}

/** The command has said how it went, in its own output; the start screen opens again. */
async function again(ran: Promise<number>): Promise<typeof AGAIN> {
  await ran;
  return AGAIN;
}

function accountContext(home: HomeState, deps: HomeRunDeps): AccountContext {
  const recorded = home.registry.ok ? home.registry.value.accounts : {};
  return {
    recorded, host: 'github', machineIdentity: home.identity,
    suggest: deps.suggest ?? suggester(), signedIn: deps.signedIn ?? once(() => readSignedIn(home.cwd)),
  };
}

async function readSignedIn(cwd: string): Promise<string[] | null> {
  const auth = await inspectAuth(new Git(cwd));
  return signedInLogins(auth.ghPresent ? auth.gh : null, auth.stored);
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => (kept ??= read());
}

async function runOwn(prompter: Prompter, command: Command, tokens: readonly string[], argv: readonly string[]): Promise<number> {
  handOver(prompter, argv);
  prompter.suspend?.();
  const parsed = parseArgs(tokens, specFor(command));
  if (!parsed.ok) { out.fail('repown', parsed.error); return 2; }
  return command.run(parsed.value);
}

function setupArgs(cwd: string): Args {
  return { positional: [], flags: new Map([['cwd', cwd]]) };
}

function finish(prompter: Prompter, message: string, code: number): number {
  prompter.outro?.(message, code === CANCELLED_CODE);
  return code;
}

function showLines(prompter: Prompter, lines: readonly string[]): void {
  if (prompter.show) {
    prompter.show(lines);
    return;
  }
  for (const line of lines) out.line('  ' + line);
}

/** Closes the start screen's frame on the command it hands over to. */
function handOver(prompter: Prompter, argv: readonly string[]): void {
  const line = COMMAND_MARK + formatCommand(argv);
  if (prompter.outro) prompter.outro(line);
  else out.detail(line);
}

async function showTopHelp(prompter: Prompter): Promise<number> {
  handOver(prompter, ['--help']);
  const entries = await loadEntries(COMMANDS);
  for (const line of renderTopHelp(entries)) out.line(line);
  return 0;
}
