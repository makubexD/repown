// Setup's last word: `done` only when nothing is left in the way of the next push.
// Otherwise it names what is (the blockers), still exiting 0 (ADR-020, ADR-026).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIRST = ['setup', 'octocat', '--name=Octo Cat', '--email=octocat@example.invalid', '--guard', '--auto-upstream', '--no-input'];

describe('setup closes on what still blocks the next push', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); clean(box); });
  afterEach(() => box.dispose());

  const setup = (args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
    const run = spawnSync(process.execPath, [CLI, ...args], { cwd: box.dir, input: '', env: { ...process.env, NO_COLOR: '1', ...env }, encoding: 'utf8' });
    return { status: run.status ?? -1, stderr: run.stderr };
  };

  test('a variable the guard refuses: set up, but not done, and it says which', () => {
    const run = setup(FIRST, { GIT_AUTHOR_EMAIL: 'old@example.invalid' });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /done: this clone is set up/);
    assert.match(run.stderr, /set up for octocat; the next push will fail: GIT_AUTHOR_EMAIL is set\n/);
    assert.match(run.stderr, /GIT_AUTHOR_EMAIL is set in this shell: commits made here won't use octocat@example\.invalid, and the guard refuses every push while it is set \(unset it\)/);
  });

  test('a settled clone with no input still names the blocker', () => {
    setup(FIRST);
    const run = setup(['setup', 'octocat', '--no-input'], { GH_TOKEN: 'secret' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /set up for octocat; the next push will fail: GH_TOKEN is set\n/);
    assert.doesNotMatch(run.stderr, /secret/);
  });

  test('two blockers: the first in the closing line, every one listed', () => {
    box.git('config', 'author.email', 'old@example.invalid');
    const run = setup(FIRST, { GH_TOKEN: 'x' });
    assert.match(run.stderr, /set up for octocat; the next push will fail: GH_TOKEN is set \(and 1 more below\)\n/);
    assert.match(run.stderr, /author\.email is set in git config/);
  });

  // FORCE_COLOR stands for a terminal; TERM=xterm-256color for one that draws Unicode.
  const COLOUR = { FORCE_COLOR: '1', TERM: 'xterm-256color' };

  test('with colour, done leads with a green check and each command is cyan', () => {
    const run = setup(FIRST, COLOUR);
    assert.match(run.stderr, /\x1b\[32m✔\x1b\[0m done: this clone is set up for octocat\n/);
    assert.match(run.stderr, /\x1b\[36m\$ repown use octocat[^\n]*\x1b\[0m\n/);
  });

  test('with colour, a blocked closing line leads with a yellow triangle', () => {
    const run = setup(FIRST, { ...COLOUR, GH_TOKEN: 'x' });
    assert.match(run.stderr, /\x1b\[33m▲\x1b\[0m set up for octocat; the next push will fail: GH_TOKEN is set\n/);
    assert.match(run.stderr, /\n {11}GH_TOKEN is set in this shell/, 'each blocker stays deeper than the marked line above it');
  });

  test('nothing in the way: done, exactly as before', () => {
    const run = setup(FIRST);
    assert.match(run.stderr, /\n {7}done: this clone is set up for octocat\n/);
    assert.doesNotMatch(run.stderr, /next push will fail/);
  });
});

/** One commit by the account, pushed with -u to a bare origin by path. */
function clean(box: Sandbox): void {
  const remote = join(box.dir, '..', 'remote.git');
  box.git('-c', 'user.email=octocat@example.invalid', '-c', 'user.name=Octo Cat', 'commit', '--allow-empty', '-m', 'first');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', '-u', 'origin', 'main');
}
