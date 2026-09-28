// What bare `repown` runs. Not a command: cli.ts loads it only when no
// arguments were typed, so `repown guard check` never imports it.
//
// Setup starts when stdin, stderr and stdout are all terminals, in any clone,
// pinned or not. Those same terminals outside a clone, including a bare
// repository, open the start screen: a runner, so its modules load only then.
// With stdout redirected outside a clone, the top help. Everything else is status.

import { Git } from '../core/git.ts';
import { inspectRepo } from '../core/inspect.ts';
import { identityProblems } from './status.ts';
import * as out from '../ui/format.ts';
import { interactive } from '../ui/prompt.ts';

const SETUP_NOTE =
  'This clone isn\'t set up yet, so repown is starting setup (repown status shows its settings).';
const PINNED_NOTE =
  'Starting setup to check this clone (repown status shows its settings without asking anything).';

interface StartDeps {
  readonly interactive: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly git: Git;
}

type StartChoice = 'setup' | 'status' | 'help' | 'home';

/** A command name, `'help'`, or the start screen's runner. */
export type StartResult = string | (() => Promise<number>);

interface StartPick {
  readonly choice: StartChoice;
  readonly pinned: boolean;
}

/** Setup, status, the start screen, or the top help. No output: the caller prints the setup line. */
export async function chooseStart(deps: StartDeps): Promise<StartChoice> {
  return (await pickStart(deps)).choice;
}

/** Real deps for this process, plus the one stderr line when setup starts. The home runner prints nothing until it is called. */
export async function startDefault(deps: StartDeps = realDeps()): Promise<StartResult> {
  const pick = await pickStart(deps);
  if (pick.choice === 'setup') out.note(pick.pinned ? PINNED_NOTE : SETUP_NOTE);
  if (pick.choice === 'home') return startHome;
  return pick.choice;
}

function startHome(): Promise<number> {
  return import('../wizard/home-run.ts').then((mod) => mod.runHome());
}

async function pickStart(deps: StartDeps): Promise<StartPick> {
  if (!deps.interactive) return { choice: 'status', pinned: false };
  if (await deps.git.isBare()) return { choice: outsideClone(deps.stdoutIsTerminal), pinned: false };
  const repo = await inspectRepo(deps.git);
  if (!repo.isRepo) return { choice: outsideClone(deps.stdoutIsTerminal), pinned: false };
  const pinned = identityProblems(repo).length === 0;
  return { choice: deps.stdoutIsTerminal ? 'setup' : 'status', pinned };
}

/** A terminal outside a clone opens the start screen. Redirected stdout still prints the top help. */
function outsideClone(stdoutIsTerminal: boolean): StartChoice {
  return stdoutIsTerminal ? 'home' : 'help';
}

function realDeps(): StartDeps {
  return { interactive: interactive(), stdoutIsTerminal: process.stdout.isTTY === true, git: new Git(process.cwd()) };
}
