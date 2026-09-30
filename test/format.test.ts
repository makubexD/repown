// Whether a stream gets colour. Needs a stream that claims to be a terminal,
// which a spawned run never has, so this calls the decision directly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { displayPath, printable, useColour } from '../src/ui/format.ts';

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

describe('displayPath: Windows native separators, elsewhere unchanged', () => {
  const gitStyle = 'C:/Program Files/Git/mingw64/bin/git-credential-manager.exe';

  test('a git-style path is shown with the platform\'s separators', () => {
    const shown = displayPath(gitStyle);
    if (process.platform === 'win32') {
      assert.equal(shown, 'C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe');
    } else {
      assert.equal(shown, gitStyle);
    }
  });

  test('a path that is already native is left as it was read', () => {
    const native = process.platform === 'win32' ? 'C:\\Tools\\git-credential-manager.exe' : '/usr/bin/git-credential-manager';
    assert.equal(displayPath(native), native);
  });
});

describe('printable', () => {
  test('control, bidi, line-separator and byte-order characters become visible escapes; the rest is unchanged', () => {
    const odd = [0x1b, 0x7f, 0x200b, 0x202e, 0x2066, 0x2028, 0x2029, 0xfeff].map((code) => String.fromCharCode(code));
    const shown = printable('a' + odd.join('') + 'z');
    assert.equal(shown, 'a' + ['001b', '007f', '200b', '202e', '2066', '2028', '2029', 'feff'].map((hex) => String.fromCharCode(92) + 'u' + hex).join('') + 'z');
    assert.equal(printable('octocat@example.invalid · origin/main'), 'octocat@example.invalid · origin/main');
    const more = [0xad, 0x61c, 0x2060, 0xfffa, 0xe0041].map((code) => String.fromCodePoint(code)).join('');
    assert.equal(printable(more), ['00ad', '061c', '2060', 'fffa', 'e0041'].map((hex) => String.fromCharCode(92) + 'u' + hex).join(''));
  });
});
