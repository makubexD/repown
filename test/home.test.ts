// The start screen's read and the lines and menu it turns into. H5-H10.
// Clones are real repositories under a temp folder; nothing here prompts.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ok } from '../src/core/result.ts';
import { registryPath } from '../src/core/registry.ts';
import { CANCEL, type Prompter } from '../src/wizard/engine.ts';
import { readHome, type HomeState } from '../src/wizard/home-context.ts';
import { commandFor, homeNote, listedClones, menuItems, summaryLines } from '../src/wizard/home-flow.ts';
import { runHome } from '../src/wizard/home-run.ts';
import { formatCommand, printable } from '../src/wizard/setup-flow.ts';
import { displayPath } from '../src/ui/format.ts';
import { parseArgs } from '../src/ui/args.ts';
import { specFor } from '../src/ui/command.ts';
import accountsGroup from '../src/commands/accounts.ts';
import { sandbox, type Sandbox } from './helpers.ts';

describe('start screen', () => {
  let box: Sandbox;
  let root: string;
  let restore: (() => void) | undefined;
  beforeEach(() => {
    box = sandbox();
    root = join(box.dir, '..', 'projects');
    mkdirSync(root);
    restore = holdCeiling(join(box.dir, '..'));
  });
  afterEach(() => { restore?.(); box.dispose(); });

  test('H5: two clones, one set up and one not, list the unset one first', async () => {
    const unset = cloneAt(root, 'zeta', false);
    const ready = cloneAt(root, 'alpha', true);
    const home = await readHome(root);
    assert.equal(shown(home, 'Clones'), 'Clones     2 below this folder: 1 not set up, 1 set up');
    assert.equal(shown(home, 'Accounts'), 'Accounts   none recorded');
    const listed = listedClones(home).clones;
    assert.equal(listed[0]!.value, resolve(unset));
    assert.equal(listed[1]!.value, resolve(ready));
    assert.equal(listed[0]!.hint, 'not set up');
    assert.equal(listed[1]!.hint, 'set up');
    assert.equal(menuItems(home).find((item) => item.label === 'Set up a clone found here')?.hint, '1 not set up');
  });

  test('H6: no clones below says none, shows the cd note, and offers no setup', async () => {
    const home = await readHome(root);
    assert.equal(shown(home, 'Clones'), 'Clones     none below this folder (2 levels)');
    assert.equal(homeNote(home), 'cd into a clone (or git clone one), then run repown');
    assert.equal(menuItems(home).some((item) => item.label === 'Set up a clone found here'), false);
  });

  test('H7: the helper line and the fix item appear only when gh is the helper', async () => {
    const absent = await readHome(root);
    assert.equal(summaryLines(absent).some((line) => line.includes('Helper')), false);
    assert.equal(menuItems(absent).some((item) => item.label === 'Stop gh serving credentials'), false);
    box.git('config', '--global', '--add', 'credential.https://github.com.helper', '');
    box.git('config', '--global', '--add', 'credential.https://github.com.helper', '!gh auth git-credential');
    const present = await readHome(root);
    assert.equal(shown(present, 'Helper'), 'Helper     gh serves git\'s credentials: run repown fix');
    assert.equal(menuItems(present).some((item) => item.label === 'Stop gh serving credentials'), true);
  });

  test('H8: an unreadable registry says could not read, and the menu still works', async () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{');
    const home = await readHome(root);
    const accounts = shown(home, 'Accounts');
    assert.equal(accounts, 'Accounts   could not read ' + path);
    assert.equal(accounts.includes('none'), false);
    assert.deepEqual(menuItems(home).map((item) => item.label), [
      'Record an account', 'Check this machine', 'Show help', 'Quit',
    ]);
  });

  test('H9: dot-directories, node_modules, AppData on Windows, and depth 3 are skipped', async () => {
    cloneAt(join(root, '.hidden'), 'repo', false);
    cloneAt(join(root, 'node_modules'), 'pkg', false);
    cloneAt(join(root, 'a', 'b'), 'deep', false);
    cloneAt(join(root, 'visible'), 'repo', false);
    cloneAt(root, 'top', false);
    cloneAt(join(root, 'AppData'), 'repo', false);
    const found = (await readHome(root)).clones.map((clone) => relative(root, clone.path)).sort();
    assert.deepEqual(found, keptClones().sort());
  });

  test('H10: 25 clones list 20 and point at repown scan for the rest', { timeout: 180_000 }, async () => {
    for (let index = 0; index < 25; index++) cloneAt(root, 'c' + String(index).padStart(2, '0'), false);
    const home = await readHome(root);
    assert.equal(home.clones.length, 25);
    const list = listedClones(home);
    assert.equal(list.clones.length, 20);
    assert.equal(list.more, 'and 5 more: repown scan');
    assert.equal(list.clones[0]!.label, 'c00');
    assert.equal(list.clones[19]!.label, 'c19');
  });

  test('a registry with one valid and one unreadable entry says both, and the menu stays', async () => {
    const path = writeRegistry(JSON.stringify({ accounts: {
      octocat: { name: 'Octo Cat', email: 'octocat@example.invalid' },
      broken: { name: 1 },
    } }));
    cloneAt(root, 'need', false);
    const home = await readHome(root);
    assert.equal(shown(home, 'Accounts'),
      'Accounts   1 recorded, 1 unreadable in ' + path + ': run repown accounts list');
    const labels = menuItems(home).map((item) => item.label);
    assert.ok(labels.includes('Set up a clone found here'));
    assert.ok(labels.includes('Record an account'));
  });

  test('a registry with only unreadable entries does not say none recorded', async () => {
    const path = writeRegistry(JSON.stringify({ accounts: { broken: {} } }));
    const home = await readHome(root);
    const accounts = shown(home, 'Accounts');
    assert.equal(accounts, 'Accounts   1 unreadable in ' + path + ': run repown accounts list');
    assert.equal(accounts.includes('none'), false);
    assert.deepEqual(menuItems(home).map((item) => item.label), [
      'Record an account', 'Check this machine', 'Show help', 'Quit',
    ]);
  });

  test('a stray .git file in this folder does not hide the clones below it', async () => {
    const child = cloneAt(root, 'need', false);
    const nested = cloneAt(join(root, 'group'), 'deep', false);
    writeFileSync(join(root, '.git'), 'not a repository\n');
    const found = (await readHome(root)).clones.map((clone) => relative(root, clone.path)).sort();
    assert.deepEqual(found, [relative(root, child), relative(root, nested)].sort());
  });

  test('a child with an empty .git directory is not listed', async () => {
    mkdirSync(join(root, 'empty', '.git'), { recursive: true });
    const real = cloneAt(root, 'need', false);
    const found = (await readHome(root)).clones.map((clone) => clone.path);
    assert.deepEqual(found, [resolve(real)]);
  });

  test('a refused .git one level down does not hide the clone inside it', async () => {
    mkdirSync(join(root, 'archive', '.git'), { recursive: true });
    const app = cloneAt(join(root, 'archive'), 'app', false);
    const found = (await readHome(root)).clones.map((clone) => relative(root, clone.path));
    assert.deepEqual(found, [relative(root, app)]);
  });

  test('a refused .git at depth 2 does not open a search at depth 3', async () => {
    const stuck = join(root, 'level', 'stop');
    mkdirSync(join(stuck, '.git'), { recursive: true });
    cloneAt(stuck, 'too-deep', false);
    const found = (await readHome(root)).clones.map((clone) => relative(root, clone.path));
    assert.deepEqual(found, []);
  });

  test('a bare repository is not walked for clones', async () => {
    execFileSync('git', ['init', '--bare', '-q', root]);
    cloneAt(root, 'decoy', false);
    const home = await readHome(root);
    assert.deepEqual(home.clones, []);
    assert.equal(shown(home, 'Clones'), 'Clones     none below this folder (2 levels)');
  });

  test('a registry key containing ESC or a newline is shown escaped', () => {
    const accounts = {
      'octo\ncat': { name: 'Octo Cat', email: 'octocat@example.invalid' },
      'octo\x1bcat': { name: 'Octo Cat', email: 'octocat@example.invalid' },
    };
    const home: HomeState = {
      cwd: 'work', registry: ok({ accounts, unreadable: [] }), ghIsHelper: false, clones: [], identity: { name: null, email: null },
    };
    const line = shown(home, 'Accounts');
    const escaped = [printable('octo\ncat'), printable('octo\x1bcat')].join(', ');
    assert.equal(line, 'Accounts   2 recorded: ' + escaped);
    assert.equal(/[\x00-\x1f]/.test(line), false);
  });

  test('the title escapes control characters in the folder path', async () => {
    const cwd = join('work', 'octo\x1bcode');
    const title = await shownTitle(cwd);
    assert.equal(title, 'repown · not a clone: ' + displayPath(printable(cwd)));
    assert.equal(title.includes('\x1b'), false);
  });

  test('a clone label escapes control characters and the value stays the path', () => {
    const cwd = join('work', 'code');
    const path = join(cwd, 'odd\tname');
    const home: HomeState = {
      cwd, registry: ok({ accounts: {}, unreadable: [] }), ghIsHelper: false,
      clones: [{ path, setUp: false }], identity: { name: null, email: null },
    };
    const [choice] = listedClones(home).clones;
    assert.equal(choice!.value, path);
    assert.equal(choice!.label, printable('odd\tname'));
    assert.equal(choice!.label.includes('\t'), false);
  });
});

describe('start screen commands', () => {
  test('an action is the command it stands for', () => {
    const path = join('work', 'need');
    const setup = commandFor({ kind: 'setup', path });
    assert.deepEqual(setup, ['setup', '--cwd=' + path]);
    assert.match(formatCommand(setup), /repown setup --cwd /);
    assert.deepEqual(commandFor({ kind: 'fix' }), ['fix']);
    const profile = { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' };
    const account = commandFor({ kind: 'account', login: 'octocat', ...profile });
    assert.deepEqual(account, ['accounts', 'add', '--name=Octo Cat', '--email=octocat@example.invalid', '--host=github', '--', 'octocat'],
      'the same command setup runs for a new account, so accounts add asks nothing more');
    assert.equal(formatCommand(account), "repown accounts add octocat --name 'Octo Cat' --email octocat@example.invalid");
    const parsed = parseArgs(account.slice(2), specFor(accountsGroup.actions['add']!));
    assert.ok(parsed.ok, 'accounts add accepts the argv the start screen builds');
    assert.deepEqual(parsed.value.positional, ['octocat']);
    const dash = commandFor({ kind: 'account', login: '-h', ...profile });
    const dashed = parseArgs(dash.slice(2), specFor(accountsGroup.actions['add']!));
    assert.ok(dashed.ok && dashed.value.positional[0] === '-h', 'a dashed login stays the account');
    assert.deepEqual(dash.slice(-2), ['--', '-h']);
    assert.match(formatCommand(dash), / -- -h$/);
    assert.deepEqual(commandFor({ kind: 'doctor' }), ['doctor']);
  });
});

async function shownTitle(cwd: string): Promise<string> {
  let title = '';
  await runHome({ prompter: cancelPrompter((text) => { title = text; }), cwd, read: emptyRead });
  return title;
}

function cancelPrompter(intro: (title: string) => void): Prompter {
  const stop = async (): Promise<typeof CANCEL> => CANCEL;
  return {
    intro, note() {}, close() {}, show() {},
    choose: stop, ask: stop, pickStep: stop,
    review: async () => 'done', confirmStep: async () => 'stop',
  };
}

function emptyRead(cwd: string): Promise<HomeState> {
  return Promise.resolve({ cwd, registry: ok({ accounts: {}, unreadable: [] }), ghIsHelper: false, clones: [], identity: { name: null, email: null } });
}

function writeRegistry(raw: string): string {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  return path;
}

function shown(home: Awaited<ReturnType<typeof readHome>>, label: string): string {
  const line = summaryLines(home).find((text) => text.includes(label));
  assert.ok(line, label);
  return line;
}

function keptClones(): string[] {
  const found = ['top', join('visible', 'repo')];
  if (process.platform !== 'win32') found.push(join('AppData', 'repo'));
  return found;
}

function cloneAt(parent: string, name: string, setUp: boolean): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (!setUp) return dir;
  execFileSync('git', ['config', '--local', 'user.name', 'Octo Cat'], { cwd: dir });
  execFileSync('git', ['config', '--local', 'user.email', 'octocat@example.invalid'], { cwd: dir });
  return dir;
}

function holdCeiling(dir: string): () => void {
  const saved = process.env['GIT_CEILING_DIRECTORIES'];
  process.env['GIT_CEILING_DIRECTORIES'] = dir;
  return () => {
    if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = saved;
  };
}
