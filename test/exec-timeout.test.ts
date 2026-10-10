// What a timeout stops (ADR-026). A timed-out git can leave what it started running: the
// git on Windows' PATH is often a wrapper whose real git outlives it, and an alias's shell
// outlives git anywhere. Those keep the output pipes open, and run() waited for them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/core/exec.ts';

const LINGER_S = 8;

test('a timed-out git is reported promptly though what it started holds the pipes; on Windows that is stopped too', async () => {
  const marker = join(tmpdir(), 'repown-linger-' + process.pid + '-' + Date.now());
  const alias = '!sleep ' + LINGER_S + '; echo late > "' + marker.replace(/\\/g, '/') + '"';
  const started = Date.now();
  const result = await run('git', ['-c', 'alias.linger=' + alias, 'linger'], { cwd: tmpdir(), timeoutMs: 1500 });
  const elapsed = Date.now() - started;
  try {
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < (LINGER_S - 2) * 1000, 'run() answered after ' + elapsed + ' ms, as late as the shell git started');
    await new Promise((done) => setTimeout(done, (LINGER_S + 2) * 1000 - elapsed));
    if (process.platform === 'win32') assert.equal(existsSync(marker), false, 'the shell git started was stopped with it');
  } finally {
    rmSync(marker, { force: true });
  }
});

test('a child that answers in time is untouched', async () => {
  const result = await run(process.execPath, ['-e', 'console.log("ok")'], { timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'ok');
  assert.equal(result.timedOut, undefined);
});
