// The compiler is injected so the cache is tested without csc, on every OS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { compileFakeExe, type CompileFake } from './fake-exe.ts';

const SOURCE = 'class Fake { static int Main() { return 0; } }';

function record(calls: string[]): CompileFake {
  return (source, outFile) => {
    calls.push(source);
    writeFileSync(outFile, source);
  };
}

test('the same source is compiled once and the binary is reused', () => {
  const calls: string[] = [];
  const compile = record(calls);
  const first = compileFakeExe('gh.exe', SOURCE, compile);
  const again = compileFakeExe('gh.exe', SOURCE, compile);
  assert.equal(calls.length, 1, 'compiled ' + String(calls.length) + ' times');
  assert.equal(again, first);
  assert.equal(readFileSync(first, 'utf8'), SOURCE);
  const other = compileFakeExe('gh.exe', SOURCE + '\n', compile);
  const gcm = compileFakeExe('git-credential-manager.exe', SOURCE, compile);
  assert.notEqual(other, first);
  assert.notEqual(gcm, first);
  assert.equal(calls.length, 3);
});
