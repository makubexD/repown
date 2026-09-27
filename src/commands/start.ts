// What bare `repown` runs. Not a command: cli.ts loads it only when no
// arguments were typed, so `repown guard check` never imports it.
//
// Setup starts only when stdin, stderr and stdout are all terminals and the
// clone isn't set up. A terminal that isn't a clone, including a bare
// repository, prints the top help. Everything else is status.

import { Git } from '../core/git.ts';
import { inspectRepo } from '../core/inspect.ts';
import { identityProblems } from './status.ts';
import * as out from '../ui/format.ts';
import { interactive } from '../ui/prompt.ts';

const SETUP_NOTE =
  'This clone isn\'t set up yet, so repown is starting setup (repown status shows its settings).';

interface StartDeps {
  readonly interactive: boolean;
  readonly stdoutIsTerminal: boolean;
  readonly git: Git;
}

/** Setup, status, or the top help. No output: the caller prints the setup line. */
export async function chooseStart(deps: StartDeps): Promise<'setup' | 'status' | 'help'> {
  if (!deps.interactive) return 'status';
  if (await deps.git.isBare()) return 'help';
  const repo = await inspectRepo(deps.git);
  if (!repo.isRepo) return 'help';
  if (deps.stdoutIsTerminal && identityProblems(repo).length > 0) return 'setup';
  return 'status';
}

/** Real deps for this process, plus the one stderr line when setup starts. */
export async function startDefault(deps: StartDeps = realDeps()): Promise<string> {
  const choice = await chooseStart(deps);
  if (choice === 'setup') out.note(SETUP_NOTE);
  return choice;
}

function realDeps(): StartDeps {
  return { interactive: interactive(), stdoutIsTerminal: process.stdout.isTTY === true, git: new Git(process.cwd()) };
}
