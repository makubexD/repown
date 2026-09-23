// Exercises the command surface itself -- dispatch, help, parsing, exit codes
// and the stdout/stderr split -- by spawning the real entry point rather than
// calling functions directly. `npm test` never touched any of this before
// (CLI-14); the CI `install` job only smoke-tests a handful of commands after
// a global install.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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

function gid(args: readonly string[], options: { cwd?: string; input?: string } = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    input: options.input ?? '',
    env: process.env,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('gid --version / --help', () => {
  test('--version prints the version from package.json', () => {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const run = gid(['--version']);
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), 'gid ' + pkg.version);
  });

  test('--help exits 0 and lists every command', () => {
    const run = gid(['--help']);
    assert.equal(run.status, 0);
    for (const name of ['status', 'use', 'off', 'doctor', 'fix', 'guard', 'accounts', 'scan']) {
      assert.match(run.stdout, new RegExp('\\b' + name + '\\b'));
    }
  });
});

describe('help is side-effect free', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('`off --help` does not unpin the clone', () => {
    box.git('config', '--local', 'user.name', 'Should Not Change');
    const run = gid(['off', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(box.git('config', '--local', '--get', 'user.name'), 'Should Not Change');
  });

  test('`guard on --help` does not install the hook', () => {
    const run = gid(['guard', 'on', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), false);
  });

  test('`guard --help` (no action) shows the group, not the default action', () => {
    const run = gid(['guard', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Actions:/);
  });
});

describe('usage errors', () => {
  test('an unknown option is refused and corrected, on stderr, exit 2', () => {
    const run = gid(['use', 'octocat', '--emial', 'x@example.invalid']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /unknown option --emial/);
  });

  test('an unknown command is refused and corrected', () => {
    const run = gid(['statuss']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /did you mean 'status'\?/);
  });

  test('an unknown guard action is refused and lists the real ones', () => {
    const run = gid(['guard', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /known: on, off, status, check/);
  });

  test('`use` with no account names the missing positional, not a stack trace', () => {
    const run = gid(['use']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /FAIL/);
  });

  test('scan rejects a non-numeric --depth before touching the filesystem', () => {
    const run = gid(['scan', '--depth', 'abc']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /invalid --depth 'abc'/);
  });

  test('scan rejects a root that does not exist', () => {
    const run = gid(['scan', join(tmpdir(), 'gid-no-such-directory-xyz')]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no such directory/);
  });
});

describe('gid help <command> / <group> <action>', () => {
  test('`gid help guard` shows the group, not the default action', () => {
    const run = gid(['help', 'guard']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /Actions:/);
  });

  test('`gid help guard on` shows the action itself', () => {
    const run = gid(['help', 'guard', 'on']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /gid guard on/);
    assert.doesNotMatch(run.stdout, /Actions:/);
  });

  test('`gid help <unknown command>` is refused, exit 2', () => {
    const run = gid(['help', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Unknown command: bogus/);
  });

  test('`gid help guard <unknown action>` is refused, exit 2', () => {
    const run = gid(['help', 'guard', 'bogus']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Unknown action: bogus/);
  });
});

describe('hidden aliases resolve to the same action as their canonical name', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('`guard enable` installs the hook, exactly like `guard on`', () => {
    const run = gid(['guard', 'enable'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), true);
  });

  test('`guard disable` removes it, exactly like `guard off`', () => {
    const run = gid(['guard', 'disable'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.equal(existsSync(join(box.dir, '.git', 'hooks', 'pre-push')), false);
  });

  test('an alias is never advertised in help', () => {
    const run = gid(['guard', '--help'], { cwd: box.dir });
    assert.equal(run.status, 0);
    assert.doesNotMatch(run.stdout, /\benable\b/);
    assert.doesNotMatch(run.stdout, /\bdisable\b/);
  });
});

describe('accounts add --host', () => {
  let configDir: string;
  before(() => { configDir = mkdtempSync(join(tmpdir(), 'gid-registry-')); });
  after(() => rmSync(configDir, { recursive: true, force: true }));

  test('an unrecognised host is refused before anything is written', () => {
    const run = spawnSync(process.execPath, [CLI, 'accounts', 'add', 'x', '--host', 'nope'], {
      env: { ...process.env, GID_CONFIG_DIR: configDir },
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--host must be one of: github, azdo, generic/);
    assert.equal(existsSync(join(configDir, 'accounts.json')), false);
  });
});

describe('`accounts remove` (alias) reaches the same action as `accounts rm`', () => {
  let configDir: string;
  before(() => { configDir = mkdtempSync(join(tmpdir(), 'gid-registry-')); });
  after(() => rmSync(configDir, { recursive: true, force: true }));

  test('removes an account recorded via `accounts add`', () => {
    const env = { ...process.env, GID_CONFIG_DIR: configDir };
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
    const run = gid(['guard', 'check', '--remote', 'origin', '--url', ORIGIN], { cwd: box.dir, input: stdin });
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
    const run = gid(['guard', 'check', '--remote', 'origin', '--url', ORIGIN], { cwd: box.dir, input: stdin });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not authored as/);
  });
});
