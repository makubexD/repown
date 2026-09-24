// Whether a stream gets colour. Needs a stream that claims to be a terminal,
// which a spawned run never has, so this calls the decision directly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useColour } from '../src/ui/format.ts';

const TERMINAL = { isTTY: true } as NodeJS.WriteStream;
const PIPE = { isTTY: false } as NodeJS.WriteStream;
const NAMES = ['FORCE_COLOR', 'NO_COLOR', 'TERM'] as const;

describe('useColour: FORCE_COLOR, then NO_COLOR, then TERM=dumb, then the stream', () => {
  let saved: Map<string, string | undefined>;
  beforeEach(() => {
    saved = new Map(NAMES.map((name) => [name, process.env[name]]));
    for (const name of NAMES) delete process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  test('a terminal gets colour and a pipe does not', () => {
    assert.deepEqual([useColour(TERMINAL), useColour(PIPE)], [true, false]);
  });

  test('TERM=dumb turns colour off on a terminal', () => {
    process.env['TERM'] = 'dumb';
    assert.equal(useColour(TERMINAL), false);
  });

  test('FORCE_COLOR still wins over TERM=dumb', () => {
    process.env['TERM'] = 'dumb';
    process.env['FORCE_COLOR'] = '1';
    assert.equal(useColour(TERMINAL), true);
  });
});
