// What bare `repown` runs. Not a command: cli.ts loads it only when no
// arguments were typed, so `repown guard check` never imports it.
//
// A terminal whose clone isn't set up starts setup. A terminal that isn't a
// clone prints the top help. Everything else, including no terminal at all,
// is status.

import { Git } from '../core/git.ts';
import { inspectRepo } from '../core/inspect.ts';
import { identityProblems } from './status.ts';
import * as out from '../ui/format.ts';
import { interactive } from '../ui/prompt.ts';

const SETUP_NOTE =
  'This clone isn\'t set up yet, so repown is starting setup (repown status shows its settings).';

/** Setup, status, or the top help. No output: the caller prints the setup line. */
export async function chooseStart(deps: { interactive: boolean; git: Git }): Promise<'setup' | 'status' | 'help'> {
  if (!deps.interactive) return 'status';
  const repo = await inspectRepo(deps.git);
  if (!repo.isRepo) return 'help';
  return identityProblems(repo).length > 0 ? 'setup' : 'status';
}

/** Real deps for this process, plus the one stderr line when setup starts. */
export async function startDefault(): Promise<string> {
  const choice = await chooseStart({ interactive: interactive(), git: new Git(process.cwd()) });
  if (choice === 'setup') out.note(SETUP_NOTE);
  return choice;
}
