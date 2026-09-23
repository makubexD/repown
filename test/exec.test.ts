// The subprocess layer, run in a child Node so the test can see what the unit
// alone cannot: whether the PROCESS is free to exit once run() has answered.
// Spawn's own `timeout` option left a 30 s timer behind whenever the binary was
// missing, and gid's status sat silent for that long after printing its result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXEC = pathToFileURL(fileURLToPath(new URL('../src/core/exec.ts', import.meta.url))).href;

test('a missing binary resolves as not installed, and leaves nothing holding the process open', () => {
  const script =
    `const { run, notInstalled } = await import(${JSON.stringify(EXEC)});` +
    `console.log(notInstalled(await run('gid-definitely-missing-binary', [])));`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.stdout.trim(), 'true', result.stderr);
  assert.ok(elapsed < 5_000, `the process took ${elapsed} ms to exit`);
});
