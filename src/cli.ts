#!/usr/bin/env node
// gid -- pin a git clone to one account, and refuse to push commits that carry
// another identity.
//
// The grammar is short on purpose. `gid use <account>` has to be as quick to
// type as `gh auth switch`, or it will not be typed. Everything longer than a
// word is a command you run once per clone or once per machine.
//
// This file is DISPATCH ONLY: resolving a command (and, for a group, an
// action), handling `--help`/`-h`/`help` before a command's own `run()` ever
// sees the arguments, and reporting a usage error with an exit code of 2.
// Parsing the arguments themselves lives in ui/args.ts, which a command can
// import without pulling in this file -- importing this module runs `main()`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, hasHelpFlag } from './ui/args.ts';
import { isGroup, resolveAlias, specFor, type Command, type CommandGroup } from './ui/command.ts';
import { renderTopHelp, renderHelpFor } from './ui/help.ts';
import { suggest } from './ui/suggest.ts';
import { ok, err, type Result } from './core/result.ts';
import * as out from './ui/format.ts';

type Entry = Command | CommandGroup;
type Loader = () => Promise<Entry>;

const COMMANDS: Record<string, Loader> = {
  status: async () => (await import('./commands/status.ts')).default,
  use: async () => (await import('./commands/use.ts')).default,
  off: async () => (await import('./commands/off.ts')).default,
  doctor: async () => (await import('./commands/doctor.ts')).default,
  fix: async () => (await import('./commands/fix.ts')).default,
  guard: async () => (await import('./commands/guard.ts')).default,
  accounts: async () => (await import('./commands/accounts.ts')).default,
  scan: async () => (await import('./commands/scan.ts')).default,
};

function version(): string {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

async function loadAll(): Promise<Map<string, Entry>> {
  const names = Object.keys(COMMANDS);
  const entries = await Promise.all(names.map((name) => COMMANDS[name]!()));
  return new Map(names.map((name, index) => [name, entries[index]!]));
}

function reportUsageError(tag: string, message: string): void {
  const [first, ...rest] = message.split('\n');
  out.fail(tag, first ?? message);
  for (const line of rest) out.detail(line);
}

interface Resolved { readonly name: string; readonly entry: Entry; readonly rest: readonly string[]; }

async function resolveTop(argv: readonly string[]): Promise<Result<Resolved>> {
  const first = argv[0];
  if (first === undefined || first.startsWith('-')) {
    return ok({ name: 'status', entry: await COMMANDS['status']!(), rest: argv });
  }
  const loader = COMMANDS[first];
  if (!loader) {
    const hint = suggest(first, Object.keys(COMMANDS));
    return err('Unknown command: ' + first + hintSuffix(hint) + '\nknown: ' + Object.keys(COMMANDS).join(', '));
  }
  return ok({ name: first, entry: await loader(), rest: argv.slice(1) });
}

function hintSuffix(hint: string | null): string {
  return hint ? ` (did you mean '${hint}'?)` : '';
}

interface PickedAction {
  readonly command: Command;
  readonly action: string;
  readonly remaining: readonly string[];
  readonly explicit: boolean;
}

function resolveAction(group: CommandGroup, rest: readonly string[]): Result<PickedAction> {
  const first = rest[0];
  if (first === undefined || first.startsWith('-')) {
    return ok({ command: group.actions[group.defaultAction]!, action: group.defaultAction, remaining: rest, explicit: false });
  }
  const canonical = resolveAlias(group, first);
  const command = group.actions[canonical];
  if (!command) {
    const hint = suggest(first, Object.keys(group.actions));
    return err('Unknown action: ' + first + hintSuffix(hint) + '\nknown: ' + Object.keys(group.actions).join(', '));
  }
  return ok({ command, action: canonical, remaining: rest.slice(1), explicit: true });
}

async function runLeaf(path: readonly string[], command: Command, rest: readonly string[]): Promise<number> {
  if (hasHelpFlag(rest)) { printHelp(path, command); return 0; }
  const parsed = parseArgs(rest, specFor(command));
  if (!parsed.ok) { reportUsageError(path.join(' '), parsed.error); return 2; }
  return command.run(parsed.value);
}

async function dispatch(name: string, entry: Entry, rest: readonly string[]): Promise<number> {
  if (!isGroup(entry)) return runLeaf([name], entry, rest);

  const picked = resolveAction(entry, rest);
  if (!picked.ok) { reportUsageError(name, picked.error); return 2; }
  const { command, action, remaining, explicit } = picked.value;

  if (!explicit && hasHelpFlag(remaining)) { printHelp([name], entry); return 0; }
  return runLeaf([name, action], command, remaining);
}

function printHelp(path: readonly string[], entry: Entry): void {
  for (const line of renderHelpFor(path, entry)) out.line(line);
}

async function runHelp(path: readonly string[]): Promise<number> {
  if (path.length === 0) {
    for (const line of renderTopHelp(await loadAll())) out.line(line);
    return 0;
  }
  const loader = COMMANDS[path[0]!];
  if (!loader) { reportUsageError('help', 'Unknown command: ' + path[0]); return 2; }

  const top = await loader();
  if (!isGroup(top) || path.length === 1) { printHelp([path[0]!], top); return 0; }

  const canonical = resolveAlias(top, path[1]!);
  const command = top.actions[canonical];
  if (!command) { reportUsageError('help', 'Unknown action: ' + path[1]); return 2; }
  printHelp([path[0]!, canonical], command);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v') { out.line('gid ' + version()); return 0; }
  if (argv[0] === '--help' || argv[0] === '-h') return runHelp([]);
  if (argv[0] === 'help') return runHelp(argv.slice(1));

  const top = await resolveTop(argv);
  if (!top.ok) { reportUsageError('gid', top.error); return 2; }
  return dispatch(top.value.name, top.value.entry, top.value.rest);
}

out.ignoreBrokenPipe();

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    out.fail('gid', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
