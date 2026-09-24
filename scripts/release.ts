#!/usr/bin/env node
// The release tool: repown's maintainer commands for cutting a version. Never
// shipped (package.json `files` holds only dist/), run from source with
// `node scripts/release.ts`, and normally reached through the npm scripts in
// package.json (see docs/RELEASING.md).
//
// Same grammar and dispatcher as repown itself (src/ui/dispatch.ts), so help,
// usage errors and exit codes behave identically: 0 ok, 1 failed, 2 usage error.

import { start, type Entry, type Loader } from '../src/ui/dispatch.ts';

/** How help spells the tool, so every usage line can be pasted as-is. */
const NAME = 'node scripts/release.ts';

const COMMANDS: Record<string, Loader> = {
  changelog: async () => (await import('./release/changelog.ts')).default,
};

function topHelp(entries: ReadonlyMap<string, Entry>): string[] {
  const lines = ['', '  ' + NAME + ' <command> [options]', ''];
  for (const [name, entry] of entries) lines.push('  ' + name.padEnd(10) + entry.summary);
  lines.push('', '  Run `' + NAME + ' help <command>` for its actions and options.');
  lines.push('  Every command takes --cwd <dir> (default: the current directory).', '');
  lines.push('  Exit codes: 0 success, 1 failure or refusal, 2 usage error.', '');
  return lines;
}

start({ name: NAME, commands: COMMANDS, topHelp });
