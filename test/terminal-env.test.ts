// A shell that exports colour variables must not change what the suite reads.
// sandbox() clears them for its life; plainTerminal() clears them for a file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { plainTerminal, sandbox } from './helpers.ts';

const NAMES = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'COLORTERM', 'TERM'] as const;

function read(): Map<string, string | undefined> {
  return new Map(NAMES.map((name) => [name, process.env[name]]));
}

function write(values: ReadonlyMap<string, string | undefined>): void {
  for (const [name, value] of values) put(name, value);
}

function put(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function forceAll(): void {
  process.env['NO_COLOR'] = '1';
  process.env['FORCE_COLOR'] = '1';
  process.env['CLICOLOR'] = '0';
  process.env['CLICOLOR_FORCE'] = '1';
  process.env['COLORTERM'] = 'truecolor';
  process.env['TERM'] = 'xterm-256color';
}

function assertAbsent(): void {
  for (const name of NAMES) assert.equal(process.env[name], undefined, name);
}

function assertForced(): void {
  assert.equal(process.env['NO_COLOR'], '1');
  assert.equal(process.env['FORCE_COLOR'], '1');
  assert.equal(process.env['CLICOLOR'], '0');
  assert.equal(process.env['CLICOLOR_FORCE'], '1');
  assert.equal(process.env['COLORTERM'], 'truecolor');
  assert.equal(process.env['TERM'], 'xterm-256color');
}

function around(run: () => void): void {
  const prior = read();
  try { run(); } finally { write(prior); }
}

describe('sandbox() and plainTerminal()', { concurrency: 1 }, () => {
  test('sandbox clears the six variables and dispose restores each prior value', () => {
    around(() => {
      forceAll();
      const box = sandbox();
      try { assertAbsent(); } finally { box.dispose(); }
      assertForced();
    });
  });

  test('dispose leaves a variable unset when the caller left it unset', () => {
    around(() => {
      forceAll();
      delete process.env['COLORTERM'];
      delete process.env['TERM'];
      const box = sandbox();
      try { assertAbsent(); } finally { box.dispose(); }
      assert.equal(process.env['COLORTERM'], undefined);
      assert.equal(process.env['TERM'], undefined);
      assert.equal(process.env['FORCE_COLOR'], '1');
      assert.equal(process.env['CLICOLOR_FORCE'], '1');
      assert.equal(process.env['NO_COLOR'], '1');
      assert.equal(process.env['CLICOLOR'], '0');
    });
  });

  test('plainTerminal clears the six variables and the returned function restores them', () => {
    around(() => {
      forceAll();
      delete process.env['CLICOLOR'];
      const restore = plainTerminal();
      try { assertAbsent(); } finally { restore(); }
      assert.equal(process.env['CLICOLOR'], undefined);
      assert.equal(process.env['FORCE_COLOR'], '1');
      assert.equal(process.env['NO_COLOR'], '1');
      assert.equal(process.env['CLICOLOR_FORCE'], '1');
      assert.equal(process.env['COLORTERM'], 'truecolor');
      assert.equal(process.env['TERM'], 'xterm-256color');
    });
  });
});
