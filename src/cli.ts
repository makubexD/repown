#!/usr/bin/env node
// repown -- pin a git clone to one account, and refuse to push commits that carry
// another identity.
//
// The grammar is short on purpose. `repown use <account>` has to be as quick to
// type as `gh auth switch`, or it will not be typed. Everything longer than a
// word is a command you run once per clone or once per machine.
//
// This file only DECLARES the program: its version and its top help. The command
// table lives in program.ts, so the start screen can print that help without
// importing this file -- importing this module runs repown. With no arguments,
// `chooseDefault` loads commands/start.ts and picks setup, the start screen,
// status or the top help; any argument skips that. Dispatch itself --
// resolving a command, intercepting `--help`/`-h`/`help` before a command's
// own `run()` ever sees the arguments, and exiting 2 on a usage error -- lives
// in ui/dispatch.ts. Parsing the arguments lives in ui/args.ts, which a command
// can import without pulling in this file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './program.ts';
import { renderTopHelp } from './ui/help.ts';
import { start } from './ui/dispatch.ts';

function version(): string {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

start({
  name: 'repown',
  commands: COMMANDS,
  defaultCommand: 'status',
  chooseDefault: () => import('./commands/start.ts').then((mod) => mod.startDefault()),
  topHelp: renderTopHelp,
  version,
});
