// The words on the start screen, in one place, so the summary and both prompters
// say the same thing. What is shown when comes from home-flow.ts.

import { displayPath } from '../ui/format.ts';

export const WHAT_NEXT = 'What next?';
export const WHICH_CLONE = 'Which clone?';
export const SETUP_CLONE = 'Set up a clone found here';
export const STOP_GH = 'Stop gh serving credentials';
export const RECORD_ACCOUNT = 'Record an account';
export const CHECK_MACHINE = 'Check this machine';
export const SHOW_HELP = 'Show help';
export const QUIT = 'Quit';
export const BACK_LABEL = '← Back';
export const BUSY = 'Reading this folder';
export const CD_NOTE = 'cd into a clone (or git clone one), then run repown';
export const NONE_RECORDED = 'none recorded';
export const HELPER_LINE = 'gh serves git\'s credentials: run repown fix';
export const HINT_FIX = 'repown fix';
export const HINT_ACCOUNT = 'repown accounts add';
export const HINT_DOCTOR = 'repown doctor';
export const NOT_SET_UP = 'not set up';
export const SET_UP = 'set up';
export const LOGIN_MESSAGE = 'The account\'s user name (login)';
export const LOGIN_HINT = 'the name you sign in with, e.g. octocat; not your email address';
export const CANCELLED = 'Cancelled: nothing was changed.';

export function homeTitle(cwd: string): string {
  return 'repown · not a clone: ' + displayPath(cwd);
}

export function recordedLine(names: readonly string[]): string {
  return names.length + ' recorded: ' + names.join(', ');
}

/** Entries the registry file has, but that could not be read as accounts. */
export function unreadableLine(recorded: number, unreadable: number, path: string): string {
  const tail = unreadable + ' unreadable in ' + path + ': run repown accounts list';
  return recorded === 0 ? tail : recorded + ' recorded, ' + tail;
}

export function couldNotRead(path: string): string {
  return 'could not read ' + path;
}

export function clonesNone(depth: number): string {
  return 'none below this folder (' + depth + ' levels)';
}

export function clonesSome(total: number, pending: number, ready: number): string {
  return total + ' below this folder: ' + pending + ' not set up, ' + ready + ' set up';
}

export function setupHint(pending: number, total: number): string {
  return pending > 0 ? pending + ' not set up' : total + ' set up';
}

export function moreClones(count: number): string {
  return 'and ' + count + ' more: repown scan';
}
