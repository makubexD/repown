// The per-machine account registry.
//
// Recording an account once is what makes `gid use <account>` a one-word command
// afterwards, in every repository on the machine.

import { loadRegistry, saveAccount, removeAccount, registryPath, type Account } from '../core/registry.ts';
import { providers } from '../core/hosts/index.ts';
import { ask } from '../ui/prompt.ts';
import { flagString, type Args } from '../ui/args.ts';
import type { Command, CommandGroup } from '../ui/command.ts';
import * as out from '../ui/format.ts';

async function list(): Promise<number> {
  const registry = await loadRegistry();
  const names = Object.keys(registry.accounts).sort();

  out.line();
  if (names.length === 0) {
    out.line('  No accounts recorded yet.');
    out.line();
    out.line('  Record one so `gid use <account>` never has to ask again:');
    out.line('    gid accounts add <account>');
    out.line();
    return 0;
  }
  for (const name of names) {
    const entry = registry.accounts[name]!;
    out.field(name, entry.name + ' <' + entry.email + '>' + hostSuffix(entry), 24);
  }
  out.line();
  out.line(out.dim('  ' + registryPath()));
  out.line();
  return 0;
}

function hostSuffix(entry: Account): string {
  return entry.host && entry.host !== 'github' ? '  (' + entry.host + ')' : '';
}

async function add(args: Args): Promise<number> {
  const account = args.positional[0]!;
  const hostId = flagString(args, 'host') ?? 'github';
  const suggested = await suggestProfile(hostId, account);

  const name = flagString(args, 'name') ?? await askFor('Commit name', suggested.name ?? account);
  if (name === null) return 1;
  const email = flagString(args, 'email') ?? await askFor('Commit email', suggested.email);
  if (email === null) return 1;

  const written = await saveAccount(account, { name, email, host: hostId });
  if (!written.ok) { out.fail('accounts', written.error); return 1; }

  out.pass('accounts', account + '  ' + name + ' <' + email + '>');
  out.line();
  out.line('  Use it in any clone:  gid use ' + account);
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
  out.detail('pass it directly:  gid accounts add <account> --name "..." --email "..."');
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
  out.line('  their own .git/config. Unpin one with: gid off');
  out.line();
  return 0;
}

const listAction: Command = {
  summary: 'list the accounts this machine knows',
  run: () => list(),
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
  examples: ['gid accounts add octocat'],
  run: add,
};

const rmAction: Command = {
  summary: 'forget a recorded account (clones already pinned to it are unaffected)',
  positionals: { min: 1, max: 1, label: '<account>' },
  examples: ['gid accounts rm octocat'],
  run: remove,
};

export default {
  summary: 'list or record the accounts this machine knows',
  defaultAction: 'list',
  actions: { list: listAction, add: addAction, rm: rmAction },
  aliases: { remove: 'rm' },
} satisfies CommandGroup;
