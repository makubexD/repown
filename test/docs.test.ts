// Keeps README.md honest about the command surface. Commands and each group's
// actions come from the real `gid --help` / `gid help <group>`, not a copy, so
// adding one without documenting it -- or documenting one that does not exist,
// hidden aliases included -- fails here rather than in a reader's terminal.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const WORD = /^[a-z][\w-]*$/;

function help(args: readonly string[]): string {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, '`gid ' + args.join(' ') + '` failed: ' + run.stderr);
  return run.stdout;
}

function listed(text: string, indent: number): string[] {
  const row = new RegExp('^ {' + indent + '}([a-z]+) {2,}\\S');
  return text.split('\n').flatMap((line) => row.exec(line)?.[1] ?? []);
}

/** Actions of every command that is a group; plain commands are left out. */
function groupActions(commands: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const text = help(['help', command]);
    const actions = text.split('Actions:')[1];
    if (actions !== undefined) groups.set(command, listed(actions, 4));
  }
  return groups;
}

/** The words after `gid` in every fenced line and inline code span that runs it. */
function invocations(markdown: string): string[][] {
  const parts = markdown.split('```');
  const fenced = parts.filter((_, index) => index % 2 === 1).flatMap((block) => block.split('\n'));
  const prose = parts.filter((_, index) => index % 2 === 0).join('\n');
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...fenced, ...inline].flatMap((text) => {
    const run = /^(?:\$ )?gid (.+)/.exec(text.trim());
    return run ? [run[1]!.split(/\s+/)] : [];
  });
}

function unknownActions(markdown: string, groups: ReadonlyMap<string, readonly string[]>): string[] {
  const unknown = invocations(markdown).flatMap(([group = '', action = '']) => {
    const actions = groups.get(group);
    return actions && WORD.test(action) && !actions.includes(action) ? [group + ' ' + action] : [];
  });
  return [...new Set(unknown)];
}

describe('README.md documents the real command surface', () => {
  const commands = listed(help(['--help']), 2);

  test('`gid --help` lists commands to check against', () => {
    assert.ok(commands.length >= 8, 'parsed only: ' + commands.join(', '));
  });

  test('every command appears in the README as `gid <command>`', () => {
    const missing = commands.filter((name) => !new RegExp('\\bgid ' + name + '\\b').test(README));
    assert.deepEqual(missing, [], 'commands the README never mentions');
  });

  test('every `gid <word>` the README shows is a real command', () => {
    const known = new Set([...commands, 'help']);
    const unknown = invocations(README).map(([word = '']) => word)
      .filter((word) => WORD.test(word) && !known.has(word));
    assert.deepEqual([...new Set(unknown)], [], 'README examples naming no real command');
  });

  test('every `gid <group> <action>` the README shows is a real action', () => {
    const groups = groupActions(commands);
    assert.ok(groups.has('guard') && groups.has('accounts'), 'groups parsed: ' + [...groups.keys()].join(', '));
    assert.deepEqual(unknownActions(README, groups), [], 'README examples naming no real action');
  });

  test('unknownActions catches a wrong action and a hidden alias', () => {
    const fixture = 'Run `gid accounts delete x` or:\n```\ngid guard enable\n```\n';
    const groups = new Map([['guard', ['on', 'off', 'status']], ['accounts', ['list', 'add', 'rm']]]);
    assert.deepEqual(unknownActions(fixture, groups).sort(), ['accounts delete', 'guard enable']);
  });
});
