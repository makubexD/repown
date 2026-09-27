// `repown status` says where the clone is and which settings are its own.
// S6 title, path and branch; S7 the two groups; S10 outside a repository.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TITLE = 'repown status · current settings of this clone';
for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string; }

function repown(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input: '', env: process.env, encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('repown status layout', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S6: the title is on stdout', () => {
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, new RegExp('^' + TITLE + '$', 'm'));
    assert.doesNotMatch(run.stderr, /repown status ·/);
    assert.equal(repown([], box.dir).stdout, run.stdout);
  });

  // sandbox() is `git init -b main` with no commit: the branch exists, HEAD does not.
  test('S6: path and branch, including an unborn branch', () => {
    const root = box.git('rev-parse', '--show-toplevel');
    const run = repown(['status'], box.dir);
    const title = run.stdout.indexOf(TITLE);
    const where = run.stdout.indexOf('  ' + root + '  (branch main)');
    const clone = run.stdout.indexOf('This clone');
    assert.ok(title >= 0 && where > title && clone > where, run.stdout);
  });

  test('S6: a detached HEAD shows its short hash', () => {
    box.git('commit', '--allow-empty', '-m', 'base');
    box.git('checkout', '--detach');
    const hash = box.git('rev-parse', '--short', 'HEAD');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, new RegExp('\\(detached at ' + hash + '\\)'));
    assert.doesNotMatch(run.stdout, /\(branch /);
  });

  test('S7: This clone, then This machine, with their fields', () => {
    const run = repown(['status'], box.dir);
    assert.ok(run.stdout.indexOf('This clone') < run.stdout.indexOf('This machine'));
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'origin', 'push guard']);
    assert.deepEqual(fieldsUnder(run.stdout, 'This machine'),
      ['default', 'helper', 'gh active']);
  });

  test('S7: existing values keep their wording', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /pushes as\s+octocat$/m);
    assert.match(run.stdout, /origin\s+octocat {2}\(GitHub\)/);
    assert.match(run.stdout, /push guard\s+off$/m);
    assert.match(run.stdout, /helper\s+manager$/m);
  });

  test('S7: default is the global identity an unpinned clone inherits', () => {
    unpin(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Cat\n\temail = octocat@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /commits as\s+NOT SET LOCALLY/);
    assert.match(run.stdout, /default\s+Octo Cat <octocat@example\.invalid>/);
  });

  test('S7: default stays the machine identity when this clone pins another', () => {
    pinGithub(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Work\n\temail = octo-work@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /default\s+Octo Work <octo-work@example\.invalid>/);
  });

  test('S7: default is none when neither name nor email is set', () => {
    unpin(box);
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /^ {2}default\s+none$/m);
  });
});

describe('repown status outside a repository', () => {
  test('S10: the failure is unchanged and no title is printed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'repown-not-a-repo-'));
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = join(empty, '..');
    try {
      const run = repown(['status'], empty);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, notARepo(empty));
    } finally {
      restoreCeiling(saved);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function fieldsUnder(stdout: string, heading: string): string[] {
  const lines = stdout.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, heading + ' missing from\n' + stdout);
  const labels: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    labels.push(line.trim().split(/\s{2,}/)[0] ?? '');
  }
  return labels;
}

function pinGithub(box: Sandbox): void {
  box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
  box.git('config', '--local', 'user.name', 'Octo Cat');
  box.git('config', '--local', 'user.email', 'octocat@example.invalid');
  box.git('config', '--local', 'repown.account', 'octocat');
  box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
  box.git('config', '--local', 'credential.helper', 'manager');
}

function unpin(box: Sandbox): void {
  box.git('config', '--local', '--unset', 'user.name');
  box.git('config', '--local', '--unset', 'user.email');
}

function notARepo(dir: string): string {
  return 'FAIL  repown     Not a git repository: ' + dir + '\n' +
    '       repown pins an identity per clone, so it needs one to work in.\n';
}

function restoreCeiling(saved: string | undefined): void {
  if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = saved;
}
