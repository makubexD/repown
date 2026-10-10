// Whether a stream gets colour. Needs a stream that claims to be a terminal,
// which a spawned run never has, so this calls the decision directly.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accent, displayPath, marked, printable, unicodeTerminal, useColour, type Mark } from '../src/ui/format.ts';

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

describe('unicodeTerminal: the same signals clack draws its own symbols by', () => {
  test('outside Windows every terminal but the Linux console draws Unicode', () => {
    assert.equal(unicodeTerminal({}, 'linux'), true);
    assert.equal(unicodeTerminal({ TERM: 'linux' }, 'linux'), false);
  });

  test('on Windows only a terminal known to draw it does', () => {
    assert.equal(unicodeTerminal({}, 'win32'), false);
    for (const env of [{ WT_SESSION: 'x' }, { TERM_PROGRAM: 'vscode' }, { TERM: 'xterm-256color' }, { CI: 'true' }]) {
      assert.equal(unicodeTerminal(env, 'win32'), true, JSON.stringify(env));
    }
  });
});

describe('marked and accent: decoration only where the stream has colour', () => {
  const SIGNALS = [...NAMES, 'WT_SESSION', 'TERM_PROGRAM', 'CI', 'TERMINUS_SUBLIME', 'ConEmuTask', 'TERMINAL_EMULATOR'];
  const ESC = '\x1b[';
  const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');
  let saved: Map<string, string | undefined>;
  beforeEach(() => {
    saved = new Map(SIGNALS.map((name) => [name, process.env[name]]));
    for (const name of SIGNALS) delete process.env[name];
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  test('a pipe gets the text exactly as it was', () => {
    assert.equal(marked('ok', PIPE, 'done: set up for octocat'), 'done: set up for octocat');
    assert.equal(accent(PIPE, '$ repown use octocat'), '$ repown use octocat');
  });

  test('NO_COLOR keeps a terminal plain too', () => {
    process.env['NO_COLOR'] = '1';
    assert.equal(marked('warn', TERMINAL, 'careful'), 'careful');
    assert.equal(accent(TERMINAL, 'repown use'), 'repown use');
  });

  test('a Unicode terminal gets a coloured check or triangle before the text', () => {
    process.env['TERM'] = 'xterm-256color';
    assert.equal(marked('ok', TERMINAL, 'done'), ESC + '32m✔' + ESC + '0m done');
    assert.equal(marked('warn', TERMINAL, 'careful'), ESC + '33m▲' + ESC + '0m careful');
    assert.equal(accent(TERMINAL, 'repown use'), ESC + '36mrepown use' + ESC + '0m');
  });

  test('a terminal with no Unicode signal gets ASCII marks', () => {
    if (process.platform !== 'win32') process.env['TERM'] = 'linux';
    const kinds: Mark[] = ['ok', 'warn'];
    assert.deepEqual(kinds.map((kind) => plain(marked(kind, TERMINAL, 'z'))), ['+ z', '! z']);
  });
});

// #15: the marks follow clack's own frame (ADR-027), so unicodeTerminal must agree with clack's
// `unicode` for every signal clack reads. Each case runs in a fresh process: clack reads the
// environment once, at import.
test('unicodeTerminal agrees with @clack/prompts in every terminal it tells apart', () => {
  const formatUrl = new URL('../src/ui/format.ts', import.meta.url).href;
  const script = 'const { unicode } = await import("@clack/prompts");' +
    'const { unicodeTerminal } = await import(' + JSON.stringify(formatUrl) + ');' +
    'console.log(JSON.stringify([unicode, unicodeTerminal()]));';
  const cases: NodeJS.ProcessEnv[] = [{}, { TERM: 'linux' }, { TERM: 'xterm-256color' }, { TERM: 'alacritty' }, { WT_SESSION: '1' },
    { TERM_PROGRAM: 'vscode' }, { TERM_PROGRAM: 'Terminus-Sublime' }, { TERMINUS_SUBLIME: '1' }, { CI: '1' },
    { ConEmuTask: '{cmd::Cmder}' }, { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }];
  const base = { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] };
  for (const env of cases) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...base, ...env }, encoding: 'utf8',
    });
    const [clack, ours] = JSON.parse(run.stdout || 'null') ?? [];
    assert.equal(ours, clack, JSON.stringify(env) + ' ' + run.stderr);
  }
});
