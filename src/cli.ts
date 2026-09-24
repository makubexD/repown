#!/usr/bin/env node
// repown -- pin a git clone to one account, and refuse to push commits that carry
// another identity.
//
// The grammar is short on purpose. `repown use <account>` has to be as quick to
// type as `gh auth switch`, or it will not be typed. Everything longer than a
// word is a command you run once per clone or once per machine.
//
// This file only DECLARES the program: its commands, its version and its top
// help. Dispatch itself -- resolving a command, intercepting `--help`/`-h`/`help`
// before a command's own `run()` ever sees the arguments, and exiting 2 on a
// usage error -- lives in ui/dispatch.ts. Parsing the arguments lives in
// ui/args.ts, which a command can import without pulling in this file --
// importing this module runs repown.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTopHelp } from './ui/help.ts';
import { start, type Loader } from './ui/dispatch.ts';

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

start({ name: 'repown', commands: COMMANDS, defaultCommand: 'status', topHelp: renderTopHelp, version });
