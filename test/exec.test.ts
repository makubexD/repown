// The subprocess layer, run in a child Node so the test can see what the unit
// alone cannot: whether the PROCESS is free to exit once run() has answered.
// Spawn's own `timeout` option left a 30 s timer behind whenever the binary was
// missing, and repown's status sat silent for that long after printing its result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXEC = pathToFileURL(fileURLToPath(new URL('../src/core/exec.ts', import.meta.url))).href;

test('a missing binary resolves as not installed, and leaves nothing holding the process open', () => {
  const script =
    `const { run, notInstalled } = await import(${JSON.stringify(EXEC)});` +
    `console.log(notInstalled(await run('repown-definitely-missing-binary', [])));`;
  const started = Date.now();
  // console.log colours `true` when the shell running the tests exports FORCE_COLOR.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const elapsed = Date.now() - started;

  assert.equal(result.stdout.trim(), 'true', result.stderr);
  assert.ok(elapsed < 5_000, `the process took ${elapsed} ms to exit`);
});

// Credential helpers and git print secrets on stdout. Whatever a child prints is
// RETURNED to the caller; this layer itself must never be what shows it.
test('a child\'s output is returned, never written to the console', () => {
  const script =
    `const { run } = await import(${JSON.stringify(EXEC)});` +
    `const r = await run(process.execPath, ['-e', 'console.log("password=SECRET"); console.error("E-SECRET")']);` +
    `if (!r.stdout.includes('SECRET') || !r.stderr.includes('E-SECRET')) process.exit(3);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, 'run() must return what the child printed');
  assert.equal(result.stdout + result.stderr, '', 'nothing may reach the console');
});

test('a killed child is marked as timed out, not left to read as an ordinary failure', () => {
  const script =
    `const { run } = await import(${JSON.stringify(EXEC)});` +
    `const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });` +
    `console.log(JSON.stringify({ timedOut: r.timedOut === true }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.deepEqual(JSON.parse(result.stdout), { timedOut: true }, result.stderr);
});
