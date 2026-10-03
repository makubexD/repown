// The real entry point: exit codes of status, doctor and fix; scan; off; two collaborators (split from cli.test.ts).

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

describe('repown status, doctor and fix: exit codes and what they change', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());
  const GH_HELPER = '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n' +
                    '[credential "https://gist.github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n';

  test('S3: bare repown without a terminal prints status and never the setup wizard', () => {
    box.git('config', '--local', '--unset', 'user.name');
    box.git('config', '--local', '--unset', 'user.email');
    box.writeGlobalConfig('[user]\n\tname = Machine\n\temail = machine@example.invalid\n');
    const run = repown([], { cwd: box.dir });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^repown status · current settings of this clone$/m);
    assert.match(run.stderr, /machine@example\.invalid/);
    assert.doesNotMatch(run.stdout + run.stderr, /needs a terminal to ask|Which account should this clone/);
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
