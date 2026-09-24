// The per-machine account registry.
//
// Recording an account once is what makes `repown use <account>` a one-word command
// afterwards, in every repository on the machine.

import { loadRegistry, saveAccount, removeAccount, registryPath, type Account } from '../core/registry.ts';
import { providers } from '../core/hosts/index.ts';
import { ask, interactive } from '../ui/prompt.ts';
import { flagString, wantsJson, FORMAT_OPTION, type Args } from '../ui/args.ts';
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
  // Only when something is left to ask, and someone is there to answer: the
  // suggestion is a network call.
  const complete = flagString(args, 'name') !== null && flagString(args, 'email') !== null;
  const suggested = complete || !interactive() ? {} : await suggestProfile(hostId, account);

  const name = flagString(args, 'name') ?? await askFor('Commit name', suggested.name ?? account);
  if (name === null) return 1;
  const email = flagString(args, 'email') ?? await askFor('Commit email', suggested.email);
  if (email === null) return 1;

  const written = await saveAccount(account, { name, email, host: hostId });
  if (!written.ok) { out.fail('accounts', written.error); return 1; }

  out.pass('accounts', account + '  ' + name + ' <' + email + '>');
  out.line();
  out.line('  Use it in any clone:  repown use ' + account);
  out.line();
  return 0;
}

/** Best effort. A host that cannot be asked simply contributes no suggestion. */
async function suggestProfile(hostId: string, account: string): Promise<{ name?: string; email?: string }> {
  const provider = providers().find((candidate) => candidate.id === hostId);
  if (!provider?.resolveProfile) return {};
  return (await provider.resolveProfile(account)) ?? {};
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
  if (!removed.value) { out.warn('accounts', account + ' was not recorded.'); return 0; }

  out.pass('accounts', 'removed ' + account);
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
  summary: 'record an account (asks for name/email once, then remembers)',
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
  summary: 'list or record the accounts this machine knows',
  defaultAction: 'list',
  actions: { list: listAction, add: addAction, remove: removeAction },
  // `rm` was the advertised name first; it keeps working, unadvertised.
  aliases: { rm: 'remove' },
} satisfies CommandGroup;
