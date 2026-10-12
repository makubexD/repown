// How many git processes one command starts in a plain pinned clone (ADR-029). On Windows a
// git spawn costs ~75 ms idle, so a read repeated inside one run is time the user waits. Each
// budget is what the command needs today: lower it when a change reads less, never raise it
// without a reason recorded in ADR-029. Only git is counted; gh and Git Credential Manager
// depend on what this machine has installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, type Sandbox } from './helpers.ts';
import { quietEnv, repown } from './status-helpers.ts';

const COUNTER = pathToFileURL(join(import.meta.dirname, 'fixtures', 'count-spawns.ts')).href;

const BUDGET = { setup: 132, use: 36, status: 39 };

function spawnsOf(box: Sandbox, args: readonly string[]): { count: number; repeated: string[]; stderr: string } {
  const log = join(box.dir, '..', 'spawns.log');
  rmSync(log, { force: true });
  const env = { ...quietEnv(), REPOWN_SPAWN_LOG: log, NODE_OPTIONS: '--import ' + COUNTER };
  const run = repown(args, box.dir, env);
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  const repeated = [...new Set(calls.filter((call, index) => calls.indexOf(call) !== index))];
  return { count: calls.length, repeated, stderr: run.stderr };
}

test('setup, use and status stay within their git spawn budgets', () => {
  const box = sandbox();
  try {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    box.git('commit', '--allow-empty', '-m', 'first');
    const counts = {
      setup: spawnsOf(box, ['setup', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid', '--guard', '--no-input']),
      use: spawnsOf(box, ['use', 'octocat']),
      status: spawnsOf(box, ['status']),
    };
    const over = Object.entries(counts).filter(([name, found]) => found.count > BUDGET[name as keyof typeof BUDGET]);
    const said = Object.entries(counts).map(([name, found]) => name + ' ' + found.count + ' (budget ' + BUDGET[name as keyof typeof BUDGET] + ')');
    const repeats = over.map(([name, found]) => name + ' repeats: ' + found.repeated.join(' '));
    assert.deepEqual(over.map(([name]) => name), [], [said.join(', '), ...repeats].join('\n'));
  } finally {
    box.dispose();
  }
});
