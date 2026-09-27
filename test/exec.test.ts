// The subprocess layer, run in a child Node so the test can see what the unit
// alone cannot: whether the PROCESS is free to exit once run() has answered.
// Spawn's own `timeout` option left a 30 s timer behind whenever the binary was
// missing, and repown's status sat silent for that long after printing its result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// `inherit` is the terminal hand-off. The child prints on the inherited streams;
// the result carries none of it, and this layer adds none of its own.
test('inherit returns the exit code and none of what the child printed', () => {
  const script =
    `const { inherit } = await import(${JSON.stringify(EXEC)});` +
    `const r = await inherit(process.execPath, ['-e', 'console.log("SECRET"); console.error("E-SECRET"); process.exit(4)']);` +
    `if (r.code !== 4 || r.stdout !== '' || r.stderr !== '' || r.spawnError) process.exit(3);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SECRET/);
  assert.match(result.stderr, /E-SECRET/);
});

test('inherit resolves a missing binary as not installed, and passes env through', () => {
  const marker = join(tmpdir(), 'repown-inherit-' + process.pid);
  const script = inheritEnvScript(marker);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'kept|false');
  } finally {
    rmSync(marker, { force: true });
  }
});

function inheritEnvScript(marker: string): string {
  const child = 'require("fs").writeFileSync(process.argv[1], (process.env.SENTINEL || "") + "|" + ("GH_TOKEN" in process.env))';
  return `const { inherit, notInstalled } = await import(${JSON.stringify(EXEC)});` +
    `const missing = await inherit('repown-definitely-missing-binary', []);` +
    `if (!notInstalled(missing)) process.exit(3);` +
    `const env = { SENTINEL: 'kept', PATH: process.env.PATH };` +
    `if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;` +
    `const r = await inherit(process.execPath, ['-e', ${JSON.stringify(child)}, ${JSON.stringify(marker)}], { env });` +
    `if (r.code !== 0) process.exit(4);`;
}

test('inherit ignores SIGINT only while its child runs', async () => {
  const { inherit } = await import('../src/core/exec.ts');
  const marker = join(tmpdir(), 'repown-sigint-' + process.pid);
  const stop = marker + '.stop';
  rmSync(marker, { force: true });
  rmSync(stop, { force: true });
  const child = 'const fs=require("fs");fs.writeFileSync(process.argv[1],"up");' +
    'const stop=process.argv[1]+".stop";' +
    'const wait=()=>{if(fs.existsSync(stop))process.exit(0);else setTimeout(wait,15)};wait()';
  const before = process.listenerCount('SIGINT');
  const pending = inherit(process.execPath, ['-e', child, marker]);
  try {
    const started = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - started > 5_000) throw new Error('child did not start');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    writeFileSync(stop, 'x');
    assert.equal((await pending).code, 0);
    assert.equal(process.listenerCount('SIGINT'), before);
    await inherit('repown-definitely-missing-binary', []);
    assert.equal(process.listenerCount('SIGINT'), before);
  } finally {
    writeFileSync(stop, 'x');
    await pending;
    rmSync(marker, { force: true });
    rmSync(stop, { force: true });
  }
});

test('a killed child is marked as timed out, not left to read as an ordinary failure', () => {
  const script =
    `const { run } = await import(${JSON.stringify(EXEC)});` +
    `const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });` +
    `console.log(JSON.stringify({ timedOut: r.timedOut === true }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.deepEqual(JSON.parse(result.stdout), { timedOut: true }, result.stderr);
});
