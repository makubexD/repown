// The per-machine account registry.
//
// Recording an account once is what makes `repown use <account>` a one-word command
// afterwards, in every repository on the machine.

import { loadRegistry, saveAccount, removeAccount, registryPath, type Account } from '../core/registry.ts';
import { lookUpProfile, providers, type Profile } from '../core/hosts/index.ts';
import { copyableCommand } from '../core/shell.ts';
import { ask, interactive } from '../ui/prompt.ts';
import { flagBool, flagString, wantsJson, FORMAT_OPTION, type Args } from '../ui/args.ts';
import { loginProblem, signedInNote } from '../wizard/setup-flow.ts';
import { readSignedIn } from '../wizard/home-context.ts';
import type { Command, CommandGroup } from '../ui/command.ts';
import * as out from '../ui/format.ts';

async function list(args: Args): Promise<number> {
  const loaded = await loadRegistry();
  if (!loaded.ok) { out.fail('accounts', loaded.error); return 1; }
  const names = Object.keys(loaded.value.accounts).sort();
  if (wantsJson(args)) return listJson(names, loaded.value.accounts, loaded.value.unreadable);

  out.line();
  if (names.length === 0) { printNoneYet(); return 0; }
  for (const name of names) {
    const entry = loaded.value.accounts[name]!;
    out.field(name, entry.name + ' <' + entry.email + '>' + hostSuffix(entry), 24);
  }
  for (const key of loaded.value.unreadable) {
    out.warn('accounts', key + ': an entry repown cannot read; it is kept, and blocks saving until fixed.');
  }
  out.line();
  out.line(out.dim('  ' + registryPath()));
  out.line();
  return 0;
}

/** One object per account, `[]` when none; an unreadable entry is still a warning on stderr. */
function listJson(names: readonly string[], accounts: Readonly<Record<string, Account>>, unreadable: readonly string[]): number {
  out.json(names.map((account) => {
    const entry = accounts[account]!;
    return { account, name: entry.name, email: entry.email, host: entry.host ?? 'github' };
  }));
  for (const key of unreadable) out.warn('accounts', key + ': an entry repown cannot read; it is kept, and blocks saving until fixed.');
  return 0;
}

function printNoneYet(): void {
  out.line('  No accounts recorded yet.');
  out.line();
  out.line('  Record one so `repown use <account>` never has to ask again:');
  out.line('    repown accounts add <account>');
  out.line();
}

function hostSuffix(entry: Account): string {
  return entry.host && entry.host !== 'github' ? '  (' + entry.host + ')' : '';
}

async function add(args: Args): Promise<number> {
  const account = args.positional[0]!;
  const hostId = flagString(args, 'host') ?? 'github';
  if (!flagBool(args, ASKED)) await warnLogin(account, hostId);
  // Only when something is left to ask, and someone is there to answer: the
  // suggestion is a network call.
  const complete = flagString(args, 'name') !== null && flagString(args, 'email') !== null;
  const suggested = complete || !interactive() ? {} : await suggestProfile(hostId, account);

  const name = flagString(args, 'name') ?? await askFor('Commit name', suggested.name ?? account);
  if (name === null) return 1;
  const email = flagString(args, 'email') ?? await askFor('Commit email', suggested.email);
  if (email === null) return 1;
  const written = await saveAccount(account, { name, email, host: hostId });
  if (!written.ok) { out.fail('accounts', out.printable(written.error)); return 1; }

  out.pass('accounts', out.printable(account) + '  ' + out.printable(name) + ' <' + out.printable(email) + '>');
  out.line();
  out.line('  Use it in any clone:  ' + out.accent(process.stdout, useCommand(account)));
  out.line();
  return 0;
}

/** Set by setup and the start screen, which said what warnLogin says while asking. Not an option, so argv can't set it. */
export const ASKED = 'asked';

/** The same arguments, marked as already asked (ASKED). */
export function asked(args: Args): Args {
  return { ...args, flags: new Map([...args.flags, [ASKED, true]]) };
}

/** What setup says while asking, said for a typed login: warnings only, it is still recorded (WIZ-10). */
async function warnLogin(account: string, hostId: string): Promise<void> {
  const shown = out.printable(account);
  const problem = loginProblem(account);
  if (problem) out.warn('accounts', '"' + shown + '": ' + problem + ', so setup would not take it (recording it anyway)');
  const clash = await recordedClash(account);
  if (clash) out.warn('accounts', clash);
  const note = hostId === 'github' ? signedInNote(account, await readSignedIn(process.cwd()), removeCommand(account)) : null;
  if (note) out.warn('accounts', note);
}

/** A recorded login spelt the same, any case: this replaces it, or sits beside it. */
async function recordedClash(account: string): Promise<string | null> {
  const loaded = await loadRegistry();
  const same = loaded.ok ? Object.keys(loaded.value.accounts).find((key) => key.toLowerCase() === account.toLowerCase()) : undefined;
  if (same === undefined) return null;
  if (same === account) return '"' + out.printable(account) + '" is already recorded: this replaces its name and email';
  return '"' + out.printable(same) + '" is already recorded on this machine: this records "' + out.printable(account) + '" beside it';
}

function removeCommand(account: string): string {
  const words = account.startsWith('-') ? ['repown', 'accounts', 'remove', '--', account] : ['repown', 'accounts', 'remove', account];
  return copyableCommand(words) ?? 'remove it with repown accounts remove';
}

/** `repown use <account>` to paste, `--` first for a dashed login; described when it can't be printed safely. */
function useCommand(account: string): string {
  const words = account.startsWith('-') ? ['repown', 'use', '--', account] : ['repown', 'use', account];
  return copyableCommand(words) ?? 'repown use, with this account\'s name';
}

/** Best effort. A host that cannot be asked simply contributes no suggestion. */
async function suggestProfile(hostId: string, account: string): Promise<Profile> {
  const found = await lookUpProfile(providers().find((candidate) => candidate.id === hostId), account);
  if (found.problem) out.warn('accounts', out.printable(found.problem) + ' (recording it anyway)');
  return found.profile;
}

async function askFor(label: string, suggestion?: string): Promise<string | null> {
  const answer = await ask(label, suggestion);
  if (answer.ok) return answer.value;
  out.fail('accounts', answer.error);
  out.detail('pass it directly:  repown accounts add <account> --name "..." --email "..."');
  return null;
}

async function remove(args: Args): Promise<number> {
  const account = args.positional[0]!;
  const removed = await removeAccount(account);
  if (!removed.ok) { out.fail('accounts', removed.error); return 1; }
  if (!removed.value) { out.warn('accounts', out.printable(account) + ' was not recorded.'); return 0; }

  out.pass('accounts', 'removed ' + out.printable(account));
  out.line();
  out.line('  Clones already pinned to it are unchanged -- their identity is in');
  out.line('  their own .git/config. Unpin one with: repown off');
  out.line();
  return 0;
}

const listAction: Command = {
  summary: 'list the accounts this machine knows',
  options: [FORMAT_OPTION],
  examples: ['repown accounts list', 'repown accounts list --format json'],
  run: list,
};

const addAction: Command = {
  summary: 'record an account (asks for its name and email once; on GitHub, suggested from its profile through gh)',
  positionals: { min: 1, max: 1, label: '<account>' },
  options: [
    { name: 'name', kind: 'string', help: 'the commit author name' },
    { name: 'email', kind: 'string', help: 'the commit author email' },
    {
      name: 'host', kind: 'string', default: 'github',
      choices: providers().map((provider) => provider.id),
      help: 'which host this account belongs to',
    },
  ],
  examples: ['repown accounts add octocat'],
  run: add,
};

const removeAction: Command = {
  summary: 'forget a recorded account (clones already pinned to it are unaffected)',
  positionals: { min: 1, max: 1, label: '<account>' },
  examples: ['repown accounts remove octocat'],
  run: remove,
};

export default {
  summary: 'list, record or forget the accounts this machine knows',
  defaultAction: 'list',
  actions: { list: listAction, add: addAction, remove: removeAction },
  // `rm` was the advertised name first; it keeps working, unadvertised.
  aliases: { rm: 'remove' },
} satisfies CommandGroup;
