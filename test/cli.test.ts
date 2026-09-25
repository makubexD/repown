// Exercises the command surface itself -- dispatch, help, parsing, exit codes
// and the stdout/stderr split -- by spawning the real entry point rather than
// calling functions directly. The CI `install` job only smoke-tests a handful of
// commands after a global install.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

// Assertions read plain text. A shell that exports FORCE_COLOR (some terminals and
// CI runners do) would otherwise colour every spawned run's output.
for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function repown(args: readonly string[], options: { cwd?: string; input?: string } = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    input: options.input ?? '',
    env: process.env,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

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

describe('repown status, doctor and fix: exit codes and what they change', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());
  const GH_HELPER = '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n' +
                    '[credential "https://gist.github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n';

  test('status exits 1 on an unpinned clone and names the address it would inherit', () => {
    box.git('config', '--local', '--unset', 'user.name');
    box.git('config', '--local', '--unset', 'user.email');
    box.writeGlobalConfig('[user]\n\tname = Machine\n\temail = machine@example.invalid\n');
    const run = repown([], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /machine@example\.invalid/);
  });

  test('status exits 0 on a pinned clone', () => {
    assert.equal(repown([], { cwd: box.dir }).status, 0);
  });

  // A submodule is its own clone, with its own config and hooks: this clone's
  // guard never sees its commits, even when `git push --recurse-submodules`
  // publishes them.
  test('status says that submodules need pinning and guarding of their own', () => {
    writeFileSync(join(box.dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octocat/lib.git\n');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /submodule/);
  });

  test('doctor exits 1 and names `repown fix` when gh is the credential helper', () => {
    box.writeGlobalConfig(GH_HELPER);
    const run = repown(['doctor'], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.match(run.stderr + run.stdout, /repown fix/);
  });

  test('fix --dry-run changes nothing', () => {
    box.writeGlobalConfig(GH_HELPER);
    assert.equal(repown(['fix', '--dry-run'], { cwd: box.dir }).status, 0);
    assert.equal(readFileSync(box.globalConfig, 'utf8'), GH_HELPER);
  });

  test('fix without --yes and without a terminal refuses and changes nothing', () => {
    box.writeGlobalConfig(GH_HELPER);
    assert.equal(repown(['fix'], { cwd: box.dir }).status, 1);
    assert.equal(readFileSync(box.globalConfig, 'utf8'), GH_HELPER);
  });

  test('fix --yes removes gh from github.com AND gist.github.com', () => {
    box.writeGlobalConfig(GH_HELPER);
    assert.equal(repown(['fix', '--yes'], { cwd: box.dir }).status, 0);
    assert.doesNotMatch(readFileSync(box.globalConfig, 'utf8'), /gh auth git-credential/);
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

describe('repown scan', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
    box.git('-c', 'user.email=someone@work.example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
  });
  afterEach(() => box.dispose());

  // Scan output gets pasted into chats and issues: domains and counts by default.
  test('shows domains, never addresses, unless --emails', () => {
    const run = repown(['scan', join(box.dir, '..')]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /work\.example\.invalid=2/);
    assert.doesNotMatch(run.stdout, /someone@/);
    assert.match(repown(['scan', join(box.dir, '..'), '--emails']).stdout, /someone@work\.example\.invalid/);
  });

  test('--format json: one object per clone, domains only, and no prose on stdout', () => {
    const run = repown(['scan', join(box.dir, '..'), '--format', 'json']);
    assert.equal(run.status, 0);
    const rows = JSON.parse(run.stdout) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      repo: rows[0]!['repo'], path: resolve(box.dir), remote: false, owner: null, host: null,
      identity: 'commits-only', guard: 'off', mirrorExcluded: false,
      history: [{ domain: 'work.example.invalid', count: 2 }],
    });
    assert.doesNotMatch(run.stdout, /someone@/);
    const withEmails = JSON.parse(repown(['scan', join(box.dir, '..'), '--format', 'json', '--emails']).stdout);
    assert.deepEqual(withEmails[0].history, [{ email: 'someone@work.example.invalid', count: 2 }]);
  });

  test('--format json with nothing found is an empty array, the warning on stderr', () => {
    const empty = mkdtempSync(join(tmpdir(), 'repown-empty-'));
    try {
      const run = repown(['scan', empty, '--format', 'json']);
      assert.equal(run.status, 0);
      assert.deepEqual(JSON.parse(run.stdout), []);
      assert.match(run.stderr, /no git repositories found/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  test('a mirror branch that does not exist does not turn the history into "unknown"', () => {
    box.git('config', '--local', 'repown.mirrorBranch', 'no-such-branch');
    const run = repown(['scan', join(box.dir, '..')]);
    assert.match(run.stdout, /work\.example\.invalid=2/);
    assert.doesNotMatch(run.stdout, /unknown|excl\. mirror/);
  });
});

describe('repown off', () => {
  let box: Sandbox;
  const pin = (): void => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    box.git('config', '--local', 'user.name', 'Octo Cat');
    box.git('config', '--local', 'user.email', 'octocat@example.invalid');
    box.git('config', '--local', 'user.useConfigOnly', 'true');
    box.git('config', '--local', 'repown.account', 'octocat');
    box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
  };
  const local = (key: string): string =>
    spawnSync('git', ['config', '--local', '--get', key], { cwd: box.dir, encoding: 'utf8' }).stdout.trim();
  beforeEach(() => { box = sandbox(); pin(); box.writeGlobalConfig('[user]\n\tname = Machine\n\temail = machine@example.invalid\n'); });
  afterEach(() => box.dispose());

  test('removes every key `use` wrote, and shows the default the clone NOW inherits', () => {
    const run = repown(['off'], { cwd: box.dir });
    assert.equal(run.status, 0);
    for (const key of ['user.name', 'user.email', 'user.useConfigOnly', 'repown.account',
                       'credential.https://github.com.username']) {
      assert.equal(local(key), '', key + ' is still set');
    }
    assert.match(run.stdout, /Machine <machine@example\.invalid>/);
    assert.doesNotMatch(run.stdout, /octocat@example\.invalid/, 'that is the identity it just removed');
  });

  test('also removes the SSH credential key an older repown pinned', () => {
    box.git('remote', 'set-url', 'origin', 'git@github.com:octocat/project.git');
    box.git('config', '--local', 'credential.ssh://github.com.username', 'octocat');
    assert.equal(repown(['off'], { cwd: box.dir }).status, 0);
    assert.equal(local('credential.ssh://github.com.username'), '');
  });

  test('with the guard on, it says every push will now be refused', () => {
    repown(['guard', 'on'], { cwd: box.dir });
    const run = repown(['off'], { cwd: box.dir });
    assert.match(run.stderr, /refuse every push/);
  });

  test('a key it could not remove is a FAILURE, not an OK', () => {
    writeFileSync(join(box.dir, '.git', 'config.lock'), '');
    const run = repown(['off'], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout, /^OK/m);
  });
});

describe('status in a clone pushing to an organisation', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('the organisation hint gives the exact repown.allowOwner command', () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /git config --local --add repown\.allowOwner octo-org/);
  });

  test('a hook repown did not write is reported with what to do about it', () => {
    mkdirSync(join(box.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(box.dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stdout, /push guard\s+foreign/);
    assert.match(run.stderr, /repown did not write/);
    assert.match(run.stderr, /delete .*pre-push, then run: repown guard on/);
  });

  test('with core.hooksPath redirecting hooks, it does not advise a `guard on` that would refuse', () => {
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'husky'));
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /core\.hooksPath/);
    assert.doesNotMatch(run.stderr, /Enable it: repown guard on/);
  });

  // ADR-009: where credentials are not pinned, `repown` says so rather than
  // implying otherwise.
  test('on a host whose credentials repown does not pin, it says so rather than "honours it"', () => {
    const azure = sandbox();
    try {
      azure.git('remote', 'add', 'origin', 'https://dev.azure.com/octo-org/p/_git/r');
      const run = repown([], { cwd: azure.dir });
      assert.match(run.stdout, /pushes as\s+not pinned by repown/);
      assert.doesNotMatch(run.stdout, /honours it/);
    } finally {
      azure.dispose();
    }
  });

  // "honours it" is a claim about the credential helper, so it is made only where
  // the helper is Git Credential Manager, the one measured to honour the pin.
  describe('the credential claim in a pinned GitHub clone', () => {
    const pinned = (helper: string | null): ReturnType<typeof repown> => {
      box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
      box.git('config', '--local', 'user.name', 'Octo Cat');
      box.git('config', '--local', 'user.email', 'octocat@users.noreply.github.com');
      box.git('config', '--local', 'repown.account', 'octocat');
      box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
      if (helper) box.git('config', '--local', 'credential.helper', helper);
      return repown([], { cwd: box.dir });
    };

    test('with Git Credential Manager as the helper, it says the pin is honoured', () => {
      assert.match(pinned('manager').stdout, /honours it/);
    });

    test('with no helper at all, it does not claim the pin is honoured, and says why', () => {
      const run = pinned(null);
      assert.doesNotMatch(run.stdout, /honours it/);
      assert.match(run.stderr, /no credential helper is set/);
    });

    test('with a helper repown has not measured, it says it cannot tell', () => {
      const run = pinned('store');
      assert.doesNotMatch(run.stdout, /honours it/);
      assert.match(run.stderr, /"store".*cannot tell whether it honours/);
    });
  });

  test('with no origin URL, it says there is no remote rather than naming an unknown host', () => {
    const bare = sandbox();
    try {
      bare.git('remote', 'add', 'origin', '');
      const run = repown([], { cwd: bare.dir });
      assert.match(run.stdout, /origin\s+no remote/);
      assert.match(run.stdout, /pushes as\s+no remote to push to/);
      assert.doesNotMatch(run.stdout, /this host/);
    } finally {
      bare.dispose();
    }
  });
});

describe('help shows an optional positional as optional', () => {
  test('`help scan` renders its directories as [<dir>...], not <dir>...', () => {
    const run = repown(['help', 'scan']);
    assert.match(run.stdout, /repown scan \[<dir>\.\.\.\]/);
  });
});

// One shared repository, two people: A pinned and guarded by repown, B with plain
// git and no repown at all. Nothing repown does may reach B, and A must be able to
// push work that already contains B's pushed commits.
describe('two collaborators, only one using repown', () => {
  const A = 'alice@example.invalid';
  const B = 'bob@example.invalid';
  let box: Sandbox;
  let root: string;
  const savedConfigDir = process.env['REPOWN_CONFIG_DIR'];
  const at = (dir: string) => (...args: string[]): string => {
    const run = spawnSync('git', args, { cwd: join(root, dir), encoding: 'utf8' });
    if (run.status !== 0) throw new Error('git ' + args.join(' ') + ' in ' + dir + ': ' + run.stderr);
    return run.stdout.trim();
  };
  const push = (dir: string, ...args: string[]) =>
    spawnSync('git', ['push', '-q', 'origin', ...args], { cwd: join(root, dir), encoding: 'utf8' });

  before(() => {
    box = sandbox();
    root = join(box.dir, '..');
    process.env['REPOWN_CONFIG_DIR'] = join(root, 'repown-config');
    box.git('init', '-q', '--bare', '-b', 'main', join(root, 'shared.git'));
    for (const [dir, email] of [['a', A], ['b', B]] as const) {
      box.git('clone', '-q', join(root, 'shared.git'), join(root, dir));
      at(dir)('config', '--local', 'user.name', dir);
      at(dir)('config', '--local', 'user.email', email);
    }
    writeFileSync(join(root, 'b', 'README'), 'project\n');
    at('b')('add', 'README');
    at('b')('commit', '-q', '-m', 'B starts the project');
    assert.equal(push('b', 'HEAD:main').status, 0);

    assert.equal(repown(['use', 'alice', '--name', 'a', '--email', A], { cwd: join(root, 'a') }).status, 0);
    assert.equal(repown(['guard', 'on'], { cwd: join(root, 'a') }).status, 0);
    at('a')('pull', '-q', 'origin', 'main');
  });
  after(() => {
    if (savedConfigDir === undefined) delete process.env['REPOWN_CONFIG_DIR'];
    else process.env['REPOWN_CONFIG_DIR'] = savedConfigDir;
    box.dispose();
  });

  test('repown leaves A\'s working tree clean, so nothing of it can be committed', () => {
    assert.equal(at('a')('status', '--porcelain'), '');
  });

  test('A pushes own work on top of B\'s pushed commits', () => {
    at('a')('commit', '-q', '--allow-empty', '-m', 'A adds a feature');
    const run = push('a', 'HEAD:main');
    assert.equal(run.status, 0, run.stderr);
  });

  test('A merges B\'s pushed branch and pushes the merge', () => {
    at('b')('pull', '-q', 'origin', 'main');
    at('b')('checkout', '-q', '-b', 'feature');
    at('b')('commit', '-q', '--allow-empty', '-m', 'B works on a branch');
    assert.equal(push('b', 'feature').status, 0);
    at('a')('fetch', '-q', 'origin');
    at('a')('merge', '-q', '--no-ff', '-m', 'A merges B', 'origin/feature');
    const run = push('a', 'HEAD:main');
    assert.equal(run.status, 0, run.stderr);
  });

  test('B, without repown, pulls and pushes as usual and receives nothing of it', () => {
    at('b')('checkout', '-q', 'main');
    at('b')('pull', '-q', 'origin', 'main');
    at('b')('commit', '-q', '--allow-empty', '-m', 'B again');
    assert.equal(push('b', 'HEAD:main').status, 0);
    assert.equal(at('b')('ls-tree', '-r', '--name-only', 'HEAD'), 'README');
    assert.equal(at('b')('config', '--local', '--get-regexp', '^(user|repown|credential)\\.'),
      'user.name b\nuser.email ' + B);
    assert.equal(existsSync(join(root, 'b', '.git', 'hooks', 'pre-push')), false);
  });

  test('A pushing a copy of B\'s commit that the remote never had is refused, by design', () => {
    at('a')('pull', '-q', '--no-rebase', 'origin', 'main');
    at('b')('commit', '-q', '--allow-empty', '-m', 'B, never pushed');
    at('a')('fetch', '-q', join(root, 'b'), 'main');
    at('a')('cherry-pick', '--allow-empty', 'FETCH_HEAD');
    const run = push('a', 'HEAD:main');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /bob@example\.invalid/);
  });
});
