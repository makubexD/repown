#!/usr/bin/env node
// gid -- pin a git clone to one account, and refuse to push commits that carry
// another identity.
//
// The grammar is short on purpose. `gid use <account>` has to be as quick to
// type as `gh auth switch`, or it will not be typed. Everything longer than a
// word is a command you run once per clone or once per machine.

import { Git } from './core/git.ts';
import * as out from './ui/format.ts';

export interface Args {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

interface Command {
  readonly summary: string;
  readonly usage: string;
  run(args: Args): Promise<number>;
}

const COMMANDS: Record<string, () => Promise<Command>> = {
  status: async () => (await import('./commands/status.ts')).default,
  use: async () => (await import('./commands/use.ts')).default,
  off: async () => (await import('./commands/off.ts')).default,
  doctor: async () => (await import('./commands/doctor.ts')).default,
  fix: async () => (await import('./commands/fix.ts')).default,
  guard: async () => (await import('./commands/guard.ts')).default,
  accounts: async () => (await import('./commands/accounts.ts')).default,
  scan: async () => (await import('./commands/scan.ts')).default,
};

/**
 * `--name value`, `--name=value` and `--flag` are all accepted; everything else
 * is positional. A token that is exactly `--` ends option parsing, so a branch
 * or path beginning with a dash can still be passed.
 */
export function parseArgs(tokens: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let optionsEnded = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (optionsEnded || !token.startsWith('--')) {
      if (token === '--') { optionsEnded = true; continue; }
      positional.push(token);
      continue;
    }
    if (token === '--') { optionsEnded = true; continue; }

    const [name, inline] = splitFlag(token);
    if (inline !== null) { flags.set(name, inline); continue; }

    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(name, next); index += 1; }
    else { flags.set(name, true); }
  }
  return { positional, flags };
}

function splitFlag(token: string): [string, string | null] {
  const body = token.slice(2);
  const equals = body.indexOf('=');
  return equals === -1 ? [body, null] : [body.slice(0, equals), body.slice(equals + 1)];
}

export function flagString(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) !== undefined && args.flags.get(name) !== 'false';
}

export function gitFor(args: Args): Git {
  return new Git(flagString(args, 'cwd') ?? process.cwd());
}

async function showHelp(): Promise<number> {
  out.line();
  out.line('  gid <command> [options]');
  out.line();
  for (const name of Object.keys(COMMANDS)) {
    const command = await COMMANDS[name]!();
    out.line('  ' + name.padEnd(10) + command.summary);
  }
  out.line();
  out.line('  Run `gid` with no command for the state of this repository.');
  out.line();
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (first === '--help' || first === '-h' || first === 'help') return showHelp();
  if (first === '--version' || first === '-v') { out.line('gid 0.1.0'); return 0; }

  // No command at all is the commonest thing anyone wants: what is the state here.
  const name = first !== undefined && first in COMMANDS ? first : 'status';
  const rest = name === first ? argv.slice(1) : argv;

  if (first !== undefined && !(first in COMMANDS) && first.startsWith('-') === false) {
    out.fail('gid', 'Unknown command: ' + first);
    out.detail('known: ' + Object.keys(COMMANDS).join(', '));
    return 2;
  }

  const command = await COMMANDS[name]!();
  return command.run(parseArgs(rest));
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    out.fail('gid', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
