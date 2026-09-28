// The start screen: a summary of this folder, then one menu. Each action prints
// the command it stands for and runs that command's own run(). Loaded only
// through the runner start.ts returns, so a typed command never imports it.
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
import { BACK, CANCEL, type Asked, type Drawn, type Prompter } from './engine.ts';
import { readHome, type HomeState } from './home-context.ts';
import { BACK as HOME_BACK, MENU, commandFor, homeNote, listedClones, menuItems, summaryLines } from './home-flow.ts';
import { BACK_LABEL, BUSY, CANCELLED, LOGIN_HINT, LOGIN_MESSAGE, QUIT, WHAT_NEXT, WHICH_CLONE, homeTitle } from './home-text.ts';
import { formatCommand, loginProblem } from './setup-flow.ts';
import { choosePrompter, runSetup } from './setup-run.ts';

const CANCELLED_CODE = 130;

export interface HomeRunDeps {
  /** The prompter to ask with. Production chooses the real one. */
  readonly prompter?: Prompter;
  readonly cwd?: string;
  /** Tests pass a fake read. Production reads this folder. */
  readonly read?: (cwd: string) => Promise<HomeState>;
}

const LOGIN_STEP: Drawn = {
  id: 'login', kind: 'text', message: LOGIN_MESSAGE, hint: LOGIN_HINT, flag: '<account>',
  validate: (value) => loginProblem(String(value)),
};

const LOGIN_ASKED: Asked = { initial: undefined, choices: [], detail: undefined, canGoBack: false };

export async function runHome(deps: HomeRunDeps = {}): Promise<number> {
  const prompter = deps.prompter ?? await choosePrompter();
  try {
    return await openHome(prompter, deps);
  } finally {
    prompter.close();
  }
}

async function openHome(prompter: Prompter, deps: HomeRunDeps): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  prompter.intro?.(homeTitle(cwd));
  prompter.busy?.(BUSY);
  const home = await (deps.read ?? readHome)(cwd);
  for (const line of summaryLines(home)) out.line(line);
  out.line();
  const note = homeNote(home);
  if (note) prompter.note(note);
  return chooseNext(prompter, home);
}

async function chooseNext(prompter: Prompter, home: HomeState): Promise<number> {
  for (;;) {
    const picked = await prompter.choose(WHAT_NEXT, menuItems(home));
    if (picked === CANCEL) return finish(prompter, CANCELLED, CANCELLED_CODE);
    const code = await dispatchChoice(picked, prompter, home);
    if (code !== null) return code;
  }
}

async function dispatchChoice(picked: string, prompter: Prompter, home: HomeState): Promise<number | null> {
  if (picked === MENU.quit) return finish(prompter, QUIT, 0);
  if (picked === MENU.help) return showTopHelp();
  if (picked === MENU.setup) return pickClone(prompter, home);
  if (picked === MENU.fix) return runOwn(prompter, fixCommand, [], commandFor({ kind: 'fix' }));
  if (picked === MENU.doctor) return runOwn(prompter, doctorCommand, [], commandFor({ kind: 'doctor' }));
  if (picked === MENU.account) return recordAccount(prompter);
  return finish(prompter, QUIT, 0);
}

async function pickClone(prompter: Prompter, home: HomeState): Promise<number | null> {
  const list = listedClones(home);
  if (list.more) out.line(list.more);
  const options = [...list.clones, { value: HOME_BACK, label: BACK_LABEL }];
  const picked = await prompter.choose(WHICH_CLONE, options);
  if (picked === CANCEL) return finish(prompter, CANCELLED, CANCELLED_CODE);
  if (picked === HOME_BACK) return null;
  return runInClone(prompter, picked);
}

async function runInClone(prompter: Prompter, cwd: string): Promise<number> {
  const argv = commandFor({ kind: 'setup', path: cwd });
  out.detail('> ' + formatCommand(argv));
  return runSetup(setupArgs(cwd), { interactive: true, prompter });
}

async function recordAccount(prompter: Prompter): Promise<number> {
  const login = await askLogin(prompter);
  if (login === CANCEL) return finish(prompter, CANCELLED, CANCELLED_CODE);
  const argv = commandFor({ kind: 'account', login });
  return runOwn(prompter, accountsGroup.actions['add']!, [login], argv);
}

async function askLogin(prompter: Prompter): Promise<string | typeof CANCEL> {
  for (;;) {
    const reply = await prompter.ask(LOGIN_STEP, LOGIN_ASKED);
    if (reply === CANCEL || reply === BACK) return CANCEL;
    const problem = loginProblem(String(reply));
    if (!problem) return String(reply).trim();
    prompter.note(problem);
  }
}

async function runOwn(prompter: Prompter, command: Command, tokens: readonly string[], argv: readonly string[]): Promise<number> {
  out.detail('> ' + formatCommand(argv));
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

async function showTopHelp(): Promise<number> {
  const entries = await loadEntries(COMMANDS);
  for (const line of renderTopHelp(entries)) out.line(line);
  return 0;
}
