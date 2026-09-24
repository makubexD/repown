// Keeps README.md honest about the command surface. Commands and each group's
// actions come from the real `repown --help` / `repown help <group>`, not a copy, so
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

const helpCache = new Map<string, string>();

function help(args: readonly string[]): string {
  const key = args.join(' ');
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, '`repown ' + key + '` failed: ' + run.stderr);
  helpCache.set(key, run.stdout);
  return run.stdout;
}

type RowFilter = (summary: string) => boolean;
const ANY: RowFilter = () => true;
/** `guard check` is listed for completeness but is the hook's, not the user's. */
const USER_FACING: RowFilter = (summary) => !summary.includes('not for direct use');

function listed(text: string, indent: number, keep: RowFilter = ANY): string[] {
  // [\w-]*: a hyphenated or digit-bearing name must not silently drop out of every check.
  const row = new RegExp('^ {' + indent + '}([a-z][\\w-]*) {2,}(\\S.*)$');
  return text.split('\n').flatMap((line) => {
    const match = row.exec(line.trimEnd());
    return match && keep(match[2]!) ? [match[1]!] : [];
  });
}

/** Actions of every command that is a group; plain commands are left out. */
function groupActions(commands: readonly string[], keep: RowFilter = ANY): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const text = help(['help', command]);
    const actions = text.split('Actions:')[1];
    if (actions !== undefined) groups.set(command, listed(actions, 4, keep));
  }
  return groups;
}

/** An action counts as documented as `repown <group> <action>` or in a `<group> a \| b` list. */
function undocumentedActions(markdown: string, groups: ReadonlyMap<string, readonly string[]>): string[] {
  return [...groups].flatMap(([group, actions]) => actions
    .filter((action) => !new RegExp('repown ' + group + ' (?:[a-z-]+ \\\\?\\| )*' + action + '(?![\\w-])').test(markdown))
    .map((action) => group + ' ' + action));
}

/** The words after `repown` in every fenced line and inline code span that runs it. */
function invocations(markdown: string): string[][] {
  const parts = markdown.split('```');
  const fenced = parts.filter((_, index) => index % 2 === 1).flatMap((block) => block.split('\n'));
  const prose = parts.filter((_, index) => index % 2 === 0).join('\n');
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  // Wherever repown is RUN: at the start, after `$ `, `&&`, `;` or `npx`.
  const run = /(?:^|&&|;|\bnpx\b)\s*(?:\$\s+)?repown\s+([^&;`]+)/g;
  return [...fenced, ...inline].flatMap((text) =>
    [...text.trim().matchAll(run)].map((match) => match[1]!.trim().split(/\s+/)));
}

/** Help declares these on every command. */
const GLOBAL_FLAGS = ['--cwd', '--help', '--version'];

/** `<command> --flag` pairs in the README that the command's (or action's) help does not declare. */
function unknownOptions(markdown: string): string[] {
  const commands = listed(help(['--help']), 2);
  const groups = groupActions(commands);
  const unknown = invocations(markdown).flatMap(([command = '', action = '', ...rest]) => {
    if (!commands.includes(command)) return [];
    const path = groups.get(command)?.includes(action) ? [command, action] : [command];
    const declared = help(['help', ...path]) + ' ' + GLOBAL_FLAGS.join(' ');
    return [action, ...rest].filter((word) => /^--[a-z]/.test(word)).map((word) => word.split('=')[0]!)
      .filter((flag) => !new RegExp(flag + '(?![\\w-])').test(declared))
      .map((flag) => command + ' ' + flag);
  });
  return [...new Set(unknown)];
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

  test('`repown --help` lists commands to check against', () => {
    assert.ok(commands.length >= 8, 'parsed only: ' + commands.join(', '));
  });

  test('every command appears in the README as `repown <command>`', () => {
    const missing = commands.filter((name) => !new RegExp('\\brepown ' + name + '\\b').test(README));
    assert.deepEqual(missing, [], 'commands the README never mentions');
  });

  test('every `repown <word>` the README shows is a real command', () => {
    const known = new Set([...commands, 'help']);
    const unknown = invocations(README).map(([word = '']) => word)
      .filter((word) => WORD.test(word) && !known.has(word));
    assert.deepEqual([...new Set(unknown)], [], 'README examples naming no real command');
  });

  test('every `repown <group> <action>` the README shows is a real action', () => {
    const groups = groupActions(commands);
    assert.ok(groups.has('guard') && groups.has('accounts'), 'groups parsed: ' + [...groups.keys()].join(', '));
    assert.deepEqual(unknownActions(README, groups), [], 'README examples naming no real action');
  });

  test('every action help advertises for users appears in the README', () => {
    assert.deepEqual(undocumentedActions(README, groupActions(commands, USER_FACING)), [],
      'actions the README never mentions');
  });

  test('undocumentedActions catches an action left out of a README list', () => {
    const fixture = '| `repown guard on \\| off` | ... |\n```\nrepown accounts list\nrepown accounts add x\nrepown accounts rm x\n```\n';
    const groups = new Map([['guard', ['on', 'off', 'status']], ['accounts', ['list', 'add', 'rm']]]);
    assert.deepEqual(undocumentedActions(fixture, groups), ['guard status']);
  });

  test('every --option the README passes to a command is one that command declares', () => {
    assert.deepEqual(unknownOptions(README), [], 'README examples using options help does not list');
  });

  test('unknownOptions catches a misspelt or invented option, wherever repown is run', () => {
    const fixture = 'Try `cd x && repown scan --no-such-flag` or\n```\nnpx repown use octocat --emial x\nrepown scan --emails\n```\n';
    assert.deepEqual(unknownOptions(fixture).sort(), ['scan --no-such-flag', 'use --emial']);
  });

  test('invocations finds repown after &&, ; and npx, not only at the start of a line', () => {
    assert.deepEqual(invocations('`cd x && repown frobnicate`').map((words) => words[0]), ['frobnicate']);
  });

  test('undocumentedActions does not count `on-demand` as documenting `on`', () => {
    const groups = new Map([['guard', ['on']]]);
    assert.deepEqual(undocumentedActions('`repown guard on-demand`', groups), ['guard on']);
  });

  test('unknownActions catches a wrong action and a hidden alias', () => {
    const fixture = 'Run `repown accounts delete x` or:\n```\nrepown guard enable\n```\n';
    const groups = new Map([['guard', ['on', 'off', 'status']], ['accounts', ['list', 'add', 'rm']]]);
    assert.deepEqual(unknownActions(fixture, groups).sort(), ['accounts delete', 'guard enable']);
  });
});
