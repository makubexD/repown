// Keeps README.md honest about the command surface. The command list comes from
// the real `gid --help`, not a copy, so adding a command without documenting it
// -- or documenting one that does not exist -- fails here rather than in a
// reader's terminal.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

function helpCommands(): string[] {
  const run = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, '`gid --help` failed: ' + run.stderr);
  const listing = run.stdout.split('\n').filter((line) => /^ {2}[a-z]+ {2,}\S/.test(line));
  return listing.map((line) => line.trim().split(/\s+/)[0]!);
}

function codeBlockInvocations(markdown: string): string[] {
  const blocks = markdown.split('```').filter((_, index) => index % 2 === 1);
  const lines = blocks.flatMap((block) => block.split('\n'));
  const invocations = lines.map((line) => /^(?:\$ )?gid ([a-z][\w-]*)/.exec(line.trim())?.[1]);
  return invocations.filter((word): word is string => word !== undefined);
}

describe('README.md documents the real command surface', () => {
  const commands = helpCommands();

  test('`gid --help` lists commands to check against', () => {
    assert.ok(commands.length >= 8, 'parsed only: ' + commands.join(', '));
  });

  test('every command appears in the README as `gid <command>`', () => {
    const missing = commands.filter((name) => !README.includes('gid ' + name));
    assert.deepEqual(missing, [], 'commands the README never mentions');
  });

  test('every `gid <word>` in a README code block is a real command', () => {
    const known = new Set([...commands, 'help']);
    const unknown = codeBlockInvocations(README).filter((word) => !known.has(word));
    assert.deepEqual([...new Set(unknown)], [], 'README examples naming no real command');
  });
});
