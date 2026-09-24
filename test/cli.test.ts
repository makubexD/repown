// Exercises the command surface itself -- dispatch, help, parsing, exit codes
// and the stdout/stderr split -- by spawning the real entry point rather than
// calling functions directly. `npm test` never touched any of this before
// (CLI-14); the CI `install` job only smoke-tests a handful of commands after
// a global install.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

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

describe('`accounts remove` (alias) reaches the same action as `accounts rm`', () => {
  let configDir: string;
  before(() => { configDir = mkdtempSync(join(tmpdir(), 'repown-registry-')); });
  after(() => rmSync(configDir, { recursive: true, force: true }));

  test('removes an account recorded via `accounts add`', () => {
    const env = { ...process.env, REPOWN_CONFIG_DIR: configDir };
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

    // --host generic: the github provider's resolveProfile calls out to `gh`
    // to suggest a name/email even when both are given explicitly; generic's
    // is a no-op, which is what keeps this test offline and deterministic.
    const added = run(['accounts', 'add', 'octocat', '--host', 'generic',
      '--name', 'Octo Cat', '--email', 'octocat@example.invalid']);
    assert.equal(added.status, 0);

    const removed = run(['accounts', 'remove', 'octocat']);
    assert.equal(removed.status, 0);
    assert.match(removed.stdout, /removed octocat/);

    const list = run(['accounts', 'list']);
    assert.doesNotMatch(list.stdout, /octocat/);
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
    box.git('remote', 'add', 'origin', 'https://github.com/An-Org/project.git');
    box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
    const run = repown([], { cwd: box.dir });
    assert.match(run.stderr, /git config --local --add repown\.allowOwner An-Org/);
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

  // DECISIONS §6: where credentials are not pinned, `repown` says so rather than
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
});

describe('help shows an optional positional as optional', () => {
  test('`help scan` renders its directories as [<dir>...], not <dir>...', () => {
    const run = repown(['help', 'scan']);
    assert.match(run.stdout, /repown scan \[<dir>\.\.\.\]/);
  });
});
