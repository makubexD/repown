// Exercises the command surface itself -- dispatch, help, parsing, exit codes
// and the stdout/stderr split -- by spawning the real entry point rather than
// calling functions directly. The CI `install` job only smoke-tests a handful of
// commands after a global install.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { compileFakeExe } from './fake-exe.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { runProgram, type DefaultChoice, type Loader, type Program } from '../src/ui/dispatch.ts';
import {
  CLI, repown, fakeProgram, FAKE_GH_CS, FAKE_GH_SH, ghEnv, recordOctocat, installFakeGh, capture, type Run,
} from './cli-helpers.ts';

describe('repown --version / --help', () => {
  test('--version prints the version from package.json', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const run = repown(['--version']);
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), 'repown ' + pkg.version);
  });

  test('--help exits 0 and lists every command', () => {
    const run = repown(['--help']);
    assert.equal(run.status, 0);
    for (const name of ['status', 'use', 'off', 'doctor', 'fix', 'guard', 'accounts', 'scan']) {
      assert.match(run.stdout, new RegExp('\\b' + name + '\\b'));
    }
  });

  test('help describes FORCE_COLOR as the code treats it: 0 or false turns colour off', () => {
    const line = repown(['--help']).stdout.split('\n').find((text) => text.trim().startsWith('FORCE_COLOR'));
    assert.match(line ?? '', /\b0\b.*\bfalse\b.*off/);
    const coloured = (value: string): boolean => /\x1b\[/.test(spawnSync(process.execPath, [CLI, 'no-such-command'],
      { env: { ...process.env, FORCE_COLOR: value }, encoding: 'utf8' }).stderr);
    assert.deepEqual([coloured('1'), coloured('0'), coloured('false')], [true, false, false]);
  });

  test('the guard summary advertises the user actions, not the hook\'s', () => {
    const line = repown(['--help']).stdout.split('\n').find((text) => text.trim().startsWith('guard'));
    assert.match(line ?? '', /on \| off \| status/);
    assert.doesNotMatch(line ?? '', /\bcheck\)/);
  });
});

describe('help is side-effect free', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('`off --help` does not unpin the clone', () => {
    box.git('config', '--local', 'user.name', 'Should Not Change');
    const run = repown(['off', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(box.git('config', '--local', '--get', 'user.name'), 'Should Not Change');
  });

  test('`guard on --help` does not install the hook', () => {
    const run = repown(['guard', 'on', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), false);
  });

  test('`guard --help` (no action) shows the group, not the default action', () => {
    const run = repown(['guard', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Actions:/);
  });
});

describe('usage errors', () => {
  test('an unknown option is refused and corrected, on stderr, exit 2', () => {
    const run = repown(['use', 'octocat', '--emial', 'x@example.invalid']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /unknown option --emial/);
  });

  test('a usage error names the help that would have avoided it', () => {
    assert.match(repown(['use', '--gg', 'octocat']).stderr, /repown help use/);
    assert.match(repown(['guard', 'on', '--gg']).stderr, /repown help guard on/);
  });

  test('a leading unknown option is blamed on repown, not on a command nobody typed', () => {
    const run = repown(['-x']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^FAIL\s+repown\s+unknown option -x/m);
    assert.doesNotMatch(run.stderr, /FAIL\s+status/);
  });

  test('an unknown command is refused and corrected', () => {
    const run = repown(['statuss']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /did you mean 'status'\?/);
  });

  test('an unknown guard action is refused and lists the real ones', () => {
    const run = repown(['guard', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /known: on, off, status, check/);
  });

  test('`use` with no account names the missing positional, not a stack trace', () => {
    const run = repown(['use']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /FAIL/);
  });

  test('`use -` is a usage error, never an account named "-"', () => {
    const run = repown(['use', '-']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option -/);
  });

  test('scan rejects a non-numeric --depth before touching the filesystem', () => {
    const run = repown(['scan', '--depth', 'abc']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /invalid --depth 'abc'/);
  });

  test('scan rejects a root that does not exist', () => {
    const run = repown(['scan', join(tmpdir(), 'repown-no-such-directory-xyz')]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no such directory/);
  });
});

describe('repown help <command> / <group> <action>', () => {
  test('`repown help guard` shows the group, not the default action', () => {
    const run = repown(['help', 'guard']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Actions:/);
  });

  test('`repown help guard on` shows the action itself', () => {
    const run = repown(['help', 'guard', 'on']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /repown guard on/);
    assert.doesNotMatch(run.stdout, /Actions:/);
  });

  test('`repown help <unknown command>` is refused, exit 2', () => {
    const run = repown(['help', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Unknown command: bogus/);
  });

  test('`repown help guard <unknown action>` is refused, exit 2', () => {
    const run = repown(['help', 'guard', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Unknown action: bogus/);
  });

  test('`repown help <typo>` corrects it the way `repown <typo>` does', () => {
    const run = repown(['help', 'stauts']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /did you mean 'status'\?/);
    assert.match(run.stderr, /known: status, use/);
    assert.match(repown(['help', 'guard', 'stauts']).stderr, /did you mean 'status'\?/);
  });

  test('command help says what the command does, under its usage', () => {
    const lines = repown(['help', 'off']).stdout.split('\n').map((line) => line.trim());
    assert.equal(lines[1], 'repown off');
    assert.equal(lines[3], 'unpin this clone (leaves global config alone)');
  });

  test('command help lists the global --cwd, since every command takes it', () => {
    assert.match(repown(['help', 'status']).stdout, /--cwd <value>\s+run as if started in this directory/);
  });

  test('group usage promises no options, because groups take none of their own', () => {
    const usage = repown(['help', 'guard']).stdout.split('\n')[1]!.trim();
    assert.equal(usage, 'repown guard <action>');
  });

  test('an empty default is not shown as "[default: ]"', () => {
    const run = repown(['help', 'guard', 'check']);
    assert.doesNotMatch(run.stdout, /\[default: \]/);
    assert.match(run.stdout, /\[default: origin\]/);
  });
});

describe('hidden aliases resolve to the same action as their canonical name', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('`guard enable` installs the hook, exactly like `guard on`', () => {
    const run = repown(['guard', 'enable'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), true);
  });

  test('`guard disable` removes it, exactly like `guard off`', () => {
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), true, 'nothing to remove: vacuous');
    const run = repown(['guard', 'disable'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), false);
  });

  test('an alias is never advertised in help', () => {
    const run = repown(['guard', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stdout, /\benable\b/);
    assert.doesNotMatch(run.stdout, /\bdisable\b/);
  });
});

describe('accounts add --host', () => {
  let configDir: string;
  before(() => { configDir = mkdtempSync(join(tmpdir(), 'repown-registry-')); });
  after(() => rmSync(configDir, { recursive: true, force: true }));

  test('an unrecognised host is refused before anything is written', () => {
    const run = spawnSync(process.execPath, [CLI, 'accounts', 'add', 'x', '--host', 'nope'], {
      env: { ...process.env, REPOWN_CONFIG_DIR: configDir },
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--host must be one of: github, azdo, generic/);
    assert.equal(existsSync(join(configDir, 'accounts.json')), false);
  });
});

describe('`accounts remove`, and `accounts rm` (hidden alias) reaching the same action', () => {
  let configDir: string;
  before(() => { configDir = mkdtempSync(join(tmpdir(), 'repown-registry-')); });
  after(() => rmSync(configDir, { recursive: true, force: true }));

  test('removes an account recorded via `accounts add`', () => {
    const env = { ...process.env, REPOWN_CONFIG_DIR: configDir };
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

    const added = run(['accounts', 'add', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid']);
    assert.equal(added.status, 0);
    assert.equal(existsSync(join(configDir, 'accounts.json')), true, 'written where REPOWN_CONFIG_DIR says');
    assert.match(run(['accounts', 'list']).stdout, /octocat\s+Octo Cat <octocat@example\.invalid>/);

    const removed = run(['accounts', 'remove', 'octocat']);
    assert.equal(removed.status, 0);
    assert.match(removed.stdout, /removed octocat/);

    const list = run(['accounts', 'list']);
    assert.doesNotMatch(list.stdout, /octocat/);

    run(['accounts', 'add', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid']);
    assert.match(run(['accounts', 'rm', 'octocat']).stdout, /removed octocat/);
  });

  test('the next command after `accounts add` is cyan where stdout has colour, and exactly as before where not', () => {
    const plain: NodeJS.ProcessEnv = { ...process.env, REPOWN_CONFIG_DIR: configDir, NO_COLOR: '1' };
    delete plain['FORCE_COLOR'];
    const add = ['accounts', 'add', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid'];
    const piped = spawnSync(process.execPath, [CLI, ...add], { env: plain, encoding: 'utf8' });
    assert.match(piped.stdout, /^ {2}Use it in any clone: {2}repown use octocat$/m);
    assert.doesNotMatch(piped.stdout, /\x1b\[/);
    const coloured = { ...process.env, REPOWN_CONFIG_DIR: configDir, FORCE_COLOR: '1', TERM: 'xterm-256color' };
    const shown = spawnSync(process.execPath, [CLI, ...add], { env: coloured, encoding: 'utf8' });
    assert.match(shown.stdout, /^ {2}Use it in any clone: {2}\x1b\[36mrepown use octocat\x1b\[0m$/m);
  });

  test('help advertises `remove`, never the `rm` alias', () => {
    const run = repown(['help', 'accounts']);
    assert.match(run.stdout, /^ {4}remove\s/m);
    assert.doesNotMatch(run.stdout, /\brm\b/);
    assert.match(repown(['help', 'accounts', 'rm']).stdout, /repown accounts remove <account>/);
  });
});

describe('accounts list --format json', () => {
  let configDir: string;
  beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'repown-registry-')); });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));
  const run = (args: readonly string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, REPOWN_CONFIG_DIR: configDir }, encoding: 'utf8' });

  test('an empty registry is an empty array, and nothing else on stdout', () => {
    const listed = run(['accounts', 'list', '--format', 'json']);
    assert.equal(listed.status, 0);
    assert.deepEqual(JSON.parse(listed.stdout), []);
  });

  test('each account is one object, sorted, with its host', () => {
    run(['accounts', 'add', 'octo-work', '--name', 'Octo Work', '--email', 'work@example.invalid', '--host', 'azdo']);
    run(['accounts', 'add', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid']);
    const listed = run(['accounts', 'list', '--format=json']);
    assert.deepEqual(JSON.parse(listed.stdout), [
      { account: 'octo-work', name: 'Octo Work', email: 'work@example.invalid', host: 'azdo' },
      { account: 'octocat', name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
    ]);
  });

  test('the default stays the human text', () => {
    assert.match(run(['accounts', 'list']).stdout, /No accounts recorded yet/);
  });

  test('an unknown format is a usage error', () => {
    const listed = run(['accounts', 'list', '--format', 'yaml']);
    assert.equal(listed.status, 2);
    assert.match(listed.stderr, /--format must be one of: text, json/);
  });
});

// A shell script cannot stand in for gh on Windows (exec never uses a shell), so
// this runs where CI has one: Linux and macOS.
describe('accounts add without a terminal', { skip: process.platform === 'win32' }, () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'repown-nogh-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('fails before asking gh for a suggestion nobody can accept', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const marker = join(root, 'gh-was-called');
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
    const run = spawnSync(process.execPath, [CLI, 'accounts', 'add', 'octocat', '--name', 'Octo Cat'], {
      env: { ...process.env, REPOWN_CONFIG_DIR: root, PATH: bin + delimiter + (process.env['PATH'] ?? '') },
      encoding: 'utf8', input: '',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /interactive terminal/);
    assert.equal(existsSync(marker), false, 'gh was asked for a profile first');
  });
});

// "off" is an answer about a repository. Outside one there is nothing to answer
// about, and printing "off" anyway made a mistyped --cwd look like a real result.
describe('guard status outside a repository', () => {
  let empty: string;
  before(() => { empty = mkdtempSync(join(tmpdir(), 'repown-not-a-repo-')); });
  after(() => rmSync(empty, { recursive: true, force: true }));

  test('fails, exit 1, and says why -- never "off"', () => {
    for (const run of [repown(['guard', 'status'], { cwd: empty }), repown(['guard'], { cwd: empty }),
                       repown(['guard', 'status', '--cwd', join(empty, 'no-such-dir')])]) {
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /FAIL\s+guard\s+Not a git repository/);
    }
  });
});

describe('guard check (the hook contract every installed hook already calls)', () => {
  let box: Sandbox;
  const OURS = 'pinned@example.invalid';
  const ORIGIN = 'https://github.com/pinned-account/project.git';

  before(() => {
    box = sandbox();
    box.git('config', '--local', 'user.name', 'Pinned');
    box.git('config', '--local', 'user.email', OURS);
    box.git('commit', '--allow-empty', '-m', 'base');
  });
  after(() => box.dispose());

  test('a correctly authored commit passes', () => {
    const sha = box.git('rev-parse', 'HEAD');
    const stdin = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
    const run = repown(['guard', 'check', '--remote', 'origin', '--url', ORIGIN], { cwd: box.dir, input: stdin });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /every commit in this push carries this clone's identity/);
  });

  test('a foreign-authored commit in the same range is refused', () => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const parent = box.git('rev-parse', 'HEAD');
    const sha = box.git(
      '-c', 'user.name=Someone', '-c', 'user.email=someone@example.invalid',
      'commit-tree', tree, '-p', parent, '-m', 'foreign',
    );
    const stdin = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
    const run = repown(['guard', 'check', '--remote', 'origin', '--url', ORIGIN], { cwd: box.dir, input: stdin });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not authored as/);
  });

  // Every hook already on disk calls `--remote "$1" --url "$2"`, and a remote can
  // be NAMED `-h`. Read as a help flag, the check printed help and exited 0.
  test('a remote named -h is a value, never a request for help', () => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const sha = box.git('-c', 'user.email=someone@example.invalid',
      'commit-tree', tree, '-p', box.git('rev-parse', 'HEAD'), '-m', 'foreign');
    const stdin = `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`;
    const run = repown(['guard', 'check', '--remote', '-h', '--url', ORIGIN], { cwd: box.dir, input: stdin });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not authored as/);
  });

  // `git push 2>&1 | true`: git hands the hook its own stderr, and a reader that
  // stops early turns the refusal's first write into EPIPE. That must never
  // become exit 0 -- the hook's exit code is the only thing git obeys.
  test('a refusal still exits non-zero when nobody is reading its output', async () => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const sha = box.git('-c', 'user.email=someone@example.invalid',
      'commit-tree', tree, '-p', box.git('rev-parse', 'HEAD'), '-m', 'foreign');
    const child = spawn(process.execPath, [CLI, 'guard', 'check', '--remote', 'origin', '--url', ORIGIN],
      { cwd: box.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.end(`refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`);
    const [code] = await once(child, 'exit') as [number | null];
    assert.notEqual(code, 0);
  });
});

describe('repown use', () => {
  let box: Sandbox;
  let configDir: string;
  const saved = process.env['REPOWN_CONFIG_DIR'];
  beforeEach(() => {
    box = sandbox();
    box.git('config', '--local', '--unset', 'user.name');
    box.git('config', '--local', '--unset', 'user.email');
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    configDir = mkdtempSync(join(tmpdir(), 'repown-use-'));
    process.env['REPOWN_CONFIG_DIR'] = configDir;
  });
  afterEach(() => {
    box.dispose();
    rmSync(configDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env['REPOWN_CONFIG_DIR']; else process.env['REPOWN_CONFIG_DIR'] = saved;
  });
  const local = (key: string): string =>
    spawnSync('git', ['config', '--local', '--get', key], { cwd: box.dir, encoding: 'utf8' }).stdout.trim();

  test('pins every key from --name and --email', () => {
    const run = repown(['use', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid'], { cwd: box.dir });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(local('user.name'), 'Octo Cat');
    assert.equal(local('user.email'), 'octocat@example.invalid');
    assert.equal(local('user.useConfigOnly'), 'true');
    assert.equal(local('repown.account'), 'octocat');
    assert.equal(local('credential.https://github.com.username'), 'octocat');
  });

  test('a write it could not make is reported as NOT pinned, never as OK', () => {
    writeFileSync(join(box.dir, '.git', 'config.lock'), '');
    const run = repown(['use', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid'], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /NOT pinned/);
    assert.doesNotMatch(run.stdout, /^OK/m);
  });

  test('with no record and no terminal it writes nothing and says how to record one', () => {
    const run = repown(['use', 'octocat'], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /repown accounts add octocat/);
    assert.equal(local('user.email'), '');
  });
});

// No TTY (spawnSync pipes stdin and stderr). The fake is the only `gh` on PATH:
// a directory that already contains gh is dropped, so this cannot fall through
// to the machine's gh. The fake records argv and never runs login, logout,
// switch or setup-git.
describe('repown use --gh with no terminal', () => {
  let box: Sandbox;
  let bin: string;
  let log: string;

  beforeEach(() => {
    box = sandbox();
    bin = join(box.dir, '..', 'fake-bin');
    log = join(box.dir, '..', 'gh.log');
    mkdirSync(bin);
    installFakeGh(bin);
    recordOctocat(box);
  });
  afterEach(() => box.dispose());

  test('G3: octocat is not in gh, so it warns and still pins', () => {
    const env = ghEnv(bin, log);
    const version = spawnSync('gh', ['--version'], { env, encoding: 'utf8' });
    assert.match(version.stdout, /repown-fake-gh/, version.stderr + (version.error?.message ?? ''));
    const run = repown(['use', 'octocat', '--gh'], { cwd: box.dir, env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK\s+identity\s+Octo Cat <octocat@example\.invalid>\n/, 'no remote, so no push-as');
    assert.match(run.stderr, /WARN\s+gh\s+octocat isn't signed in to gh/);
    assert.match(run.stderr, /fix: gh auth login, then repown use octocat --gh/);
    assert.equal(box.git('config', '--local', '--get', 'repown.account'), 'octocat');
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /auth status/);
    assert.doesNotMatch(calls, /login|logout|switch|setup-git/);
  });

  test('G3: a gh signed in to nobody warns and never calls auth switch', () => {
    const file = join(box.dir, '..', 'gh-empty-hosts.txt');
    writeFileSync(file, GH_EMPTY_HOSTS);
    const env = { ...ghEnv(bin, log), GH_FAKE_STATUS_FILE: file };
    const run = repown(['use', 'octocat', '--gh'], { cwd: box.dir, env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN\s+gh\s+octocat isn't signed in to gh/);
    assert.match(run.stderr, /fix: gh auth login, then repown use octocat --gh/);
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /auth status/);
    assert.doesNotMatch(calls, /auth switch/);
    assert.doesNotMatch(calls, /auth login|logout|setup-git/);
    const status = repown(['status'], { cwd: box.dir, env });
    assert.doesNotMatch(status.stderr, /UNVERIFIED/);
    assert.match(status.stdout, /gh active\s+none/);
  });
});

describe('help shows an optional positional as optional', () => {
  test('`help scan` renders its directories as [<dir>...], not <dir>...', () => {
    const run = repown(['help', 'scan']);
    assert.match(run.stdout, /repown scan \[<dir>\.\.\.\]/);
  });
});

describe('guard on from npx\'s cache', () => {
  let box: Sandbox;
  let root: string;
  before(() => {
    box = sandbox();
    // npx runs a package from <cache>/_npx/<hash>/node_modules/<name>. Node refuses to
    // strip types under node_modules, so the copy of the sources drops that level;
    // the _npx folder is what the check looks for.
    root = mkdtempSync(join(tmpdir(), 'repown-npx-'));
    const copy = join(root, '_npx', '0a1b2c', 'repown');
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(copy, 'src'), { recursive: true });
    cpSync(fileURLToPath(new URL('../package.json', import.meta.url)), join(copy, 'package.json'));
  });
  after(() => { box.dispose(); rmSync(root, { recursive: true, force: true }); });

  test('installs the hook, then warns that it depends on that copy', () => {
    const cli = join(root, '_npx', '0a1b2c', 'repown', 'src', 'cli.ts');
    const run = spawnSync(process.execPath, [cli, 'guard', 'on'], { cwd: box.dir, env: process.env, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /guard +on -- every push is checked/);
    assert.match(run.stderr, /npx's cache/);
    assert.match(run.stderr, /npm install -g repown/);
    const hook = readFileSync(join(box.dir, '.git', 'hooks', 'pre-push'), 'utf8');
    assert.match(hook, /_npx/, 'the hook records the copy the warning is about');
  });

  test('an installed or source copy gets no such warning', () => {
    const run = repown(['guard', 'on'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stderr, /npx/);
  });
});

// chooseDefault is consulted only for an empty argv. With none set, empty argv
// still runs defaultCommand; the release tool sets neither (release-tool.test.ts).
describe('chooseDefault', () => {
  test('an empty argv asks the chooser and runs the command it names', async () => {
    const ran: string[] = [];
    let calls = 0;
    const program = fakeProgram(async () => { calls += 1; return 'setup'; }, ran);
    const captured = await capture(() => runProgram(program, []));
    assert.equal(captured.code, 0);
    assert.equal(calls, 1);
    assert.deepEqual(ran, ['setup']);
  });

  test('help from the chooser prints the top help and runs no command', async () => {
    const ran: string[] = [];
    const captured = await capture(() => runProgram(fakeProgram(async () => 'help', ran), []));
    assert.equal(captured.code, 0);
    assert.match(captured.out, /TOP HELP/);
    assert.deepEqual(ran, []);
  });

  test('any argument skips the chooser', async () => {
    const ran: string[] = [];
    let calls = 0;
    const program = fakeProgram(async () => { calls += 1; return 'setup'; }, ran);
    await capture(() => runProgram(program, ['status']));
    await capture(() => runProgram(program, ['--cwd', 'x']));
    await capture(() => runProgram(program, ['-x']));
    assert.equal(calls, 0);
    assert.deepEqual(ran, ['status', 'status']);
  });

  test('with no chooser, empty argv still runs defaultCommand', async () => {
    const ran: string[] = [];
    const captured = await capture(() => runProgram(fakeProgram(undefined, ran), []));
    assert.equal(captured.code, 0);
    assert.deepEqual(ran, ['status']);
    assert.equal(captured.out, '');
  });

  test('a runner from the chooser is awaited and its exit code is returned', async () => {
    const ran: string[] = [];
    const program = fakeProgram(async () => () => Promise.resolve(7), ran);
    const captured = await capture(() => runProgram(program, []));
    assert.equal(captured.code, 7);
    assert.equal(captured.out, '');
    assert.deepEqual(ran, []);
  });
});
