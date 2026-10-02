// Pure: the summary, the menu and the clone list, and the command an action
// stands for. Drawing and running live in home-run.ts.

import { relative } from 'node:path';
import { registryPath, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import type { Choice } from './engine.ts';
import { HOME_DEPTH, type HomeClone, type HomeState } from './home-context.ts';
import {
  CD_NOTE, CHECK_MACHINE, HELPER_LINE, HINT_ACCOUNT, HINT_DOCTOR, HINT_FIX,
  HINT_REMOVE, NONE_RECORDED, NOT_SET_UP, QUIT, RECORD_ACCOUNT, REMOVE_ACCOUNT, SET_UP, SETUP_CLONE, SHOW_HELP, STOP_GH,
  clonesNone, clonesSome, couldNotRead, moreClones, recordedLine, setupHint, unreadableLine,
} from './home-text.ts';
import { addAccountArgv, printable, type NewAccount } from './setup-flow.ts';

/** Shown choices. `back` returns to the menu; the others run a command or leave. */
export const MENU = {
  setup: 'setup', fix: 'fix', account: 'account', remove: 'remove', doctor: 'doctor', help: 'help', quit: 'quit',
} as const;

export const BACK = 'back';

const LIST_CAP = 20;

export type HomeAction =
  | { readonly kind: 'setup'; readonly path: string }
  | { readonly kind: 'fix' }
  | ({ readonly kind: 'account' } & NewAccount)
  | { readonly kind: 'remove'; readonly login: string }
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
  return [...setupItem(home), ...fixItem(home), RECORD, ...removeItem(home), ...AFTER_REMOVE];
}

/** A recorded account's choice value; prefixed so no login (`back`, say) is ever another choice. */
const ACCOUNT_VALUE = 'account:';

export function accountOfChoice(value: string): string | null {
  return value.startsWith(ACCOUNT_VALUE) ? value.slice(ACCOUNT_VALUE.length) : null;
}

/** The recorded accounts, each with the name and email it commits as. */
export function accountChoices(home: HomeState): Choice[] {
  if (!home.registry.ok) return [];
  const accounts = home.registry.value.accounts;
  return Object.keys(accounts).sort().map((login) => ({
    value: ACCOUNT_VALUE + login, label: printable(login), hint: printable(accounts[login]!.name + ' <' + accounts[login]!.email + '>'),
  }));
}

export function listedClones(home: HomeState): CloneList {
  const ordered = orderClones(home);
  const shown = ordered.slice(0, LIST_CAP);
  const rest = ordered.length - shown.length;
  return { clones: shown.map((clone) => cloneChoice(home.cwd, clone)), more: rest > 0 ? moreClones(rest) : null };
}

/**
 * The command the action stands for. `--cwd=<path>` is how setup's own plans spell
 * it. `accounts add` is the very command setup runs for a new account: every answer
 * as a flag, and `--` before the login, so a login that starts with a dash stays the account.
 */
export function commandFor(action: HomeAction): readonly string[] {
  if (action.kind === 'setup') return ['setup', '--cwd=' + action.path];
  if (action.kind === 'fix') return ['fix'];
  if (action.kind === 'account') return addAccountArgv(action);
  if (action.kind === 'remove') return ['accounts', 'remove', '--', action.login];
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
  return names.length === 0 ? NONE_RECORDED : recordedLine(names.map(printable));
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

/** Only when every entry reads: accounts remove refuses to rewrite a file it can't fully read. */
function removeItem(home: HomeState): Choice[] {
  if (!home.registry.ok || home.registry.value.unreadable.length > 0) return [];
  return accountChoices(home).length > 0 ? [{ value: MENU.remove, label: REMOVE_ACCOUNT, hint: HINT_REMOVE }] : [];
}

function fixItem(home: HomeState): Choice[] {
  if (!home.ghIsHelper) return [];
  return [{ value: MENU.fix, label: STOP_GH, hint: HINT_FIX }];
}

const RECORD: Choice = { value: MENU.account, label: RECORD_ACCOUNT, hint: HINT_ACCOUNT };

const AFTER_REMOVE: readonly Choice[] = [
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
  return label.padEnd(10) + ' ' + value;
}
