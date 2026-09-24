// Keeps the docs honest. Commands and each group's actions come from the real
// `repown --help` / `repown help <group>`, not a copy, so adding one without
// documenting it -- or documenting one that does not exist, hidden aliases
// included -- fails here rather than in a reader's terminal. Every relative link
// and anchor must resolve, and decisions are cited by ADR id, never by section.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const WORD = /^[a-z][\w-]*$/;

/** Files under `dir` (relative to the repo root) whose name ends in `ext`. */
function filesIn(dir: string, ext: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith(ext)).map((name) => join(ROOT, dir, name));
}

const DOCS = [join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md'), ...filesIn('docs', '.md')];
const read = (path: string): string => readFileSync(path, 'utf8');
const name = (path: string): string => relative(ROOT, path).replaceAll('\\', '/');

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

describe('every other doc runs only real commands, actions and options', () => {
  const commands = listed(help(['--help']), 2);
  const groups = groupActions(commands);
  const known = new Set([...commands, 'help']);

  for (const path of DOCS.filter((doc) => doc !== join(ROOT, 'README.md'))) {
    test(name(path), () => {
      const text = read(path);
      const words = invocations(text).map(([word = '']) => word).filter((word) => WORD.test(word) && !known.has(word));
      assert.deepEqual([...new Set(words)], [], 'examples naming no real command');
      assert.deepEqual(unknownActions(text, groups), [], 'examples naming no real action');
      assert.deepEqual(unknownOptions(text), [], 'examples using options help does not list');
    });
  }
});

/** GitHub's heading anchor: closing #s, punctuation and emoji dropped, lowercase, spaces to hyphens. */
function slug(heading: string): string {
  return heading.replace(/\s+#+\s*$/, '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replaceAll(' ', '-');
}

/** The markdown outside fenced code blocks (``` or ~~~, three or more). */
function prose(markdown: string): string {
  let fence: string | null = null;
  return markdown.split('\n').filter((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker) fence = marker[0]!.repeat(marker.length);
    else if (fence !== null && marker?.startsWith(fence)) fence = null;
    else return fence === null;
    return false;
  }).join('\n');
}

/** Every anchor a markdown file offers, with GitHub's -1, -2 for repeats. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  return new Set([...prose(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
    const base = slug(match[1]!);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : base + '-' + count;
  }));
}

/**
 * Link targets: inline `[a](b)`, `[a](<b>)` and `[a](b "title")`, and reference
 * definitions `[a]: b`. Raw HTML `<a href>` is not used in these docs, so not read.
 */
function linkTargets(markdown: string): string[] {
  const inline = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const reference = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
  const text = prose(markdown);
  return [...text.matchAll(inline), ...text.matchAll(reference)].map((match) => match[1]!);
}

/** Relative links in `path` whose file or anchor does not exist. Case is only enforced on Linux CI. */
function brokenLinks(path: string): string[] {
  return linkTargets(read(path)).filter((target) => !/^[a-z]+:/i.test(target)).filter((target) => {
    const [file = '', anchor] = target.split('#');
    const resolved = file ? join(dirname(path), decodeURIComponent(file)) : path;
    if (!existsSync(resolved)) return true;
    return anchor !== undefined && resolved.endsWith('.md') && !anchors(read(resolved)).has(anchor);
  });
}

describe('links and decision references', () => {
  test('slug and anchors follow GitHub, repeats and fenced headings included', () => {
    assert.equal(slug('7. Push: what the `guard` checks'), '7-push-what-the-guard-checks');
    assert.equal(slug('🟢 Pass'), '-pass');
    assert.equal(slug('Foo ##'), 'foo');
    assert.deepEqual([...anchors('# A\n## A\n```\n# B\n```\n~~~~\n# C\n```\n~~~~\n')], ['a', 'a-1']);
  });

  test('linkTargets reads titled, angle-bracket and reference links', () => {
    const fixture = '[a](x.md "t") [b](<y.md>) [c](z.md#h)\n[d]: w.md\n```\n[e](skip.md)\n```\n';
    assert.deepEqual(linkTargets(fixture), ['x.md', 'y.md', 'z.md#h', 'w.md']);
  });

  for (const path of DOCS) {
    test('every relative link in ' + name(path) + ' resolves', () => {
      assert.deepEqual(brokenLinks(path), [], 'links to a missing file or heading');
    });
  }

  test('decisions are cited as ADR-0NN, never by section sign or the old single file', () => {
    const sources = [...DOCS, ...filesIn('src', '.ts'), ...filesIn('test', '.ts')];
    // Built from its code point, so this file does not match itself.
    const cited = new RegExp(String.fromCharCode(0xa7) + '|DECISIONS\\.md');
    const stale = sources.filter((path) => cited.test(read(path))).map(name);
    assert.deepEqual(stale, [], 'files still citing the old decisions document');
  });
});
