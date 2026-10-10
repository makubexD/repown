// What bare `repown` runs. Not a command: cli.ts loads it only when no
// arguments were typed, so `repown guard check` never imports it.
//
// Setup starts when stdin, stderr and stdout are all terminals, in any clone,
// pinned or not. It is a runner, so setup loads only then, and the lead line
// is drawn inside setup's frame rather than before it. Those same terminals
// outside a clone, including a bare repository, open the start screen: a
// runner too. With stdout redirected outside a clone, the top help.
// Everything else is status.

import { Git } from '../core/git.ts';
import { inspectRepo } from '../core/inspect.ts';
import statusCommand, { identityProblems } from './status.ts';
import type { Args } from '../ui/args.ts';
import { interactive } from '../ui/prompt.ts';
import * as out from '../ui/format.ts';

export const SETUP_NOTE =
  'This clone isn\'t set up yet, so repown is starting setup (repown status shows its settings).';
export const PINNED_NOTE =
  'Starting setup to check this clone (repown status shows its settings without asking anything).';

interface StartDeps {
  readonly interactive: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly git: Git;
  /** Git Bash's mintty without a console (minttyWithoutConsole). */
  readonly mintty?: boolean;
}

type StartChoice = 'setup' | 'status' | 'help' | 'home';

/** A command name, `'help'`, or a runner for setup or the start screen. */
export type StartResult = string | (() => Promise<number>);

interface StartPick {
  readonly choice: StartChoice;
  readonly pinned: boolean;
}

/** Setup, status, the start screen, or the top help. No output. */
export async function chooseStart(deps: StartDeps): Promise<StartChoice> {
  return (await pickStart(deps)).choice;
}

/** Real deps for this process. Setup and the start screen are runners: nothing is printed until they are called. */
export async function startDefault(deps: StartDeps = realDeps()): Promise<StartResult> {
  const pick = await pickStart(deps);
  if (pick.choice === 'setup') return () => startSetup(pick.pinned);
  if (pick.choice === 'home') return startHome;
  if (pick.choice === 'status' && !deps.interactive && deps.mintty) return statusInMintty;
  return pick.choice;
}

/**
 * mintty without ConPTY hands its programs pipes, not a console, so nothing can ask there and
 * bare repown shows status; winpty gives it a console (Git for Windows ships it).
 */
export function minttyWithoutConsole(env: NodeJS.ProcessEnv, platform: string, stdinIsTerminal: boolean): boolean {
  return platform === 'win32' && !stdinIsTerminal && env['TERM_PROGRAM'] === 'mintty';
}

function statusInMintty(): Promise<number> {
  out.noted('repown', 'mintty gives repown no console here, so it shows status: winpty repown opens the start screen');
  return statusCommand.run(bareArgs());
}

function startHome(): Promise<number> {
  return import('../wizard/home-run.ts').then((mod) => mod.runHome());
}

function startSetup(pinned: boolean): Promise<number> {
  const lead = pinned ? PINNED_NOTE : SETUP_NOTE;
  return import('../wizard/setup-run.ts').then((mod) => mod.runSetup(bareArgs(), { interactive: true, lead }));
}

function bareArgs(): Args {
  return { positional: [], flags: new Map<string, string | boolean>() };
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
  return {
    interactive: interactive(), stdoutIsTerminal: process.stdout.isTTY === true, git: new Git(process.cwd()),
    mintty: minttyWithoutConsole(process.env, process.platform, process.stdin.isTTY === true),
  };
}
