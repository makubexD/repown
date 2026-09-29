// Pure: the summary, the menu and the clone list, and the command an action
// stands for. Drawing and running live in home-run.ts.

import { relative } from 'node:path';
import { registryPath, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import type { Choice } from './engine.ts';
import { HOME_DEPTH, type HomeClone, type HomeState } from './home-context.ts';
import {
  CD_NOTE, CHECK_MACHINE, HELPER_LINE, HINT_ACCOUNT, HINT_DOCTOR, HINT_FIX,
  NONE_RECORDED, NOT_SET_UP, QUIT, RECORD_ACCOUNT, SET_UP, SETUP_CLONE, SHOW_HELP, STOP_GH,
  clonesNone, clonesSome, couldNotRead, moreClones, recordedLine, setupHint, unreadableLine,
} from './home-text.ts';
import { printable } from './setup-flow.ts';

/** Shown choices. `back` returns to the menu; the others run a command or leave. */
export const MENU = {
  setup: 'setup', fix: 'fix', account: 'account', doctor: 'doctor', help: 'help', quit: 'quit',
} as const;

export const BACK = 'back';

const LIST_CAP = 20;

export type HomeAction =
  | { readonly kind: 'setup'; readonly path: string }
  | { readonly kind: 'fix' }
  | { readonly kind: 'account'; readonly login: string }
  | { readonly kind: 'doctor' };

export interface CloneList {
  readonly clones: readonly Choice[];
  readonly more: string | null;
}

export function summaryLines(home: HomeState): string[] {
  const lines = [row('Accounts', accountsText(home.registry)), row('Clones', clonesText(home.clones))];
  if (home.ghIsHelper) lines.splice(1, 0, row('Helper', HELPER_LINE));
  return lines;
}

export function homeNote(home: HomeState): string | null {
  return home.clones.length === 0 ? CD_NOTE : null;
}

export function menuItems(home: HomeState): Choice[] {
  return [...setupItem(home), ...fixItem(home), ...STANDING];
}

export function listedClones(home: HomeState): CloneList {
  const ordered = orderClones(home);
  const shown = ordered.slice(0, LIST_CAP);
  const rest = ordered.length - shown.length;
  return { clones: shown.map((clone) => cloneChoice(home.cwd, clone)), more: rest > 0 ? moreClones(rest) : null };
}

/**
 * The command the action stands for. `--cwd=<path>` is how setup's own plans spell
 * it. `accounts add` puts `--` before the login, as that plan does, so a login
 * that starts with a dash stays the account.
 */
export function commandFor(action: HomeAction): readonly string[] {
  if (action.kind === 'setup') return ['setup', '--cwd=' + action.path];
  if (action.kind === 'fix') return ['fix'];
  if (action.kind === 'account') return ['accounts', 'add', '--', action.login];
  return ['doctor'];
}

function accountsText(registry: Result<Registry>): string {
  if (!registry.ok) return couldNotRead(registryPath());
  return accountsSummary(registry.value);
}

function accountsSummary(registry: Registry): string {
  const names = Object.keys(registry.accounts).sort();
  const unread = registry.unreadable.length;
  if (unread > 0) return unreadableLine(names.length, unread, registryPath());
  return names.length === 0 ? NONE_RECORDED : recordedLine(names);
}

function clonesText(clones: readonly HomeClone[]): string {
  if (clones.length === 0) return clonesNone(HOME_DEPTH);
  const pending = clones.filter((clone) => !clone.setUp).length;
  return clonesSome(clones.length, pending, clones.length - pending);
}

function setupItem(home: HomeState): Choice[] {
  if (home.clones.length === 0) return [];
  const pending = home.clones.filter((clone) => !clone.setUp).length;
  return [{ value: MENU.setup, label: SETUP_CLONE, hint: setupHint(pending, home.clones.length) }];
}

function fixItem(home: HomeState): Choice[] {
  if (!home.ghIsHelper) return [];
  return [{ value: MENU.fix, label: STOP_GH, hint: HINT_FIX }];
}

const STANDING: readonly Choice[] = [
  { value: MENU.account, label: RECORD_ACCOUNT, hint: HINT_ACCOUNT },
  { value: MENU.doctor, label: CHECK_MACHINE, hint: HINT_DOCTOR },
  { value: MENU.help, label: SHOW_HELP },
  { value: MENU.quit, label: QUIT },
];

function orderClones(home: HomeState): HomeClone[] {
  const rank = (clone: HomeClone): string => (clone.setUp ? '1' : '0') + relative(home.cwd, clone.path);
  return [...home.clones].sort((a, b) => rank(a).localeCompare(rank(b)));
}

function cloneChoice(cwd: string, clone: HomeClone): Choice {
  return { value: clone.path, label: printable(relative(cwd, clone.path)), hint: clone.setUp ? SET_UP : NOT_SET_UP };
}

function row(label: string, value: string): string {
  return '  ' + label.padEnd(10) + ' ' + value;
}
