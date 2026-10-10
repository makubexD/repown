// Terminal output. Deliberately plain: a fixed-width status word, a short tag
// saying which check spoke, then the message.
//
//   OK    identity   octocat <...>  push-as:octocat
//   NOTE  gh         active as someone else, so `gh pr create` would act as them
//         fix: gh auth switch -u octocat

const COLOURS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

/**
 * Colour is a property of the STREAM a line goes to, not of the process: piping
 * stdout into a file while stderr stays a terminal (`repown 2>&1 | less`, or the
 * reverse, `repown 2>err.log`) must not colour the redirected side. `NO_COLOR`
 * only counts when it is non-empty, and `FORCE_COLOR=0`/`false` turns colour
 * off even though the variable is set -- both per the NO_COLOR/FORCE_COLOR
 * conventions these variables are named after. `TERM=dumb` is a terminal that
 * cannot render escape codes, so it gets none unless FORCE_COLOR insists.
 */
export function useColour(stream: NodeJS.WriteStream): boolean {
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  if (process.env['NO_COLOR']) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return stream.isTTY === true;
}

function paint(stream: NodeJS.WriteStream, colour: keyof typeof COLOURS, text: string): string {
  return useColour(stream) ? COLOURS[colour] + text + COLOURS.reset : text;
}

/**
 * Whether the terminal draws symbols beyond ASCII: the signals @clack/prompts draws its own
 * frame by, so a mark and the frame around it never disagree. Windows' legacy console does
 * not; Windows Terminal, VS Code and mintty (TERM=xterm-256color) do (ADR-027).
 */
export function unicodeTerminal(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  if (platform !== 'win32') return env['TERM'] !== 'linux';
  return Boolean(env['CI'] || env['WT_SESSION'] || env['TERMINUS_SUBLIME'])
    || env['ConEmuTask'] === '{cmd::Cmder}'
    || ['Terminus-Sublime', 'vscode'].includes(env['TERM_PROGRAM'] ?? '')
    || ['xterm-256color', 'alacritty'].includes(env['TERM'] ?? '')
    || env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm';
}

export type Mark = 'ok' | 'warn';

/** Each mark's colour, its symbol, and the ASCII stand-in where Unicode can't be drawn. */
const MARKS: Record<Mark, { colour: keyof typeof COLOURS; unicode: string; ascii: string }> = {
  ok: { colour: 'green', unicode: '✔', ascii: '+' },
  warn: { colour: 'yellow', unicode: '▲', ascii: '!' },
};

/** `text` led by a coloured mark where `stream` has colour; exactly `text` where it has none. */
export function marked(kind: Mark, stream: NodeJS.WriteStream, text: string): string {
  if (!useColour(stream)) return text;
  const mark = MARKS[kind];
  return paint(stream, mark.colour, unicodeTerminal() ? mark.unicode : mark.ascii) + ' ' + text;
}

/** A command, cyan where `stream` has colour. */
export function accent(stream: NodeJS.WriteStream, text: string): string {
  return paint(stream, 'cyan', text);
}

/** A status word, the stream it goes to, and its colour. */
interface Level {
  readonly stream: NodeJS.WriteStream;
  readonly word: string;
  readonly colour: keyof typeof COLOURS;
}

function status(level: Level, tag: string, message: string): void {
  const word = paint(level.stream, level.colour, level.word.padEnd(5));
  level.stream.write(word + ' ' + tag.padEnd(10) + ' ' + message + '\n');
}

export function pass(tag: string, message: string): void {
  status({ stream: process.stdout, word: 'OK', colour: 'green' }, tag, message);
}

export function warn(tag: string, message: string): void {
  status({ stream: process.stderr, word: 'WARN', colour: 'yellow' }, tag, message);
}

/** Optional advice. Same columns as warn, on stderr. Dim when that stream has colour. */
export function noted(tag: string, message: string): void {
  status({ stream: process.stderr, word: 'NOTE', colour: 'dim' }, tag, message);
}

export function fail(tag: string, message: string): void {
  status({ stream: process.stderr, word: 'FAIL', colour: 'red' }, tag, message);
}

/** A continuation line under a warn or fail, aligned with its message column. */
export function detail(message: string): void {
  process.stderr.write('       ' + message + '\n');
}

/** Stderr with no indent. `detail`'s seven spaces would attach a closing tally to the row above. */
export function note(message: string): void {
  process.stderr.write(message + '\n');
}

export function line(message = ''): void {
  process.stdout.write(message + '\n');
}

/** `  label      value` -- the shape every status block uses. */
export function field(label: string, value: string, width = 14): void {
  process.stdout.write('  ' + label.padEnd(width) + ' ' + value + '\n');
}

/** `--format json`: the whole payload as one JSON document on stdout, never coloured. */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function heading(text: string): void {
  process.stdout.write('\n' + paint(process.stdout, 'dim', text) + '\n');
}

export function dim(text: string): string {
  return paint(process.stdout, 'dim', text);
}

/**
 * Control characters, and the invisible, line-breaking or direction-changing ones, as visible
 * escapes: text read from git, a remote URL or a commit must neither redraw the screen nor
 * read as another name.
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\xad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu,
    (char) => '\\u' + char.codePointAt(0)!.toString(16).padStart(4, '0'));
}

/** No column: combining marks, format characters (zero-width, bidi), variation selectors. */
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}\u{fe00}-\u{fe0f}]/u;
/** Two columns: East Asian Wide and Fullwidth, and the emoji blocks. */
const WIDE = /[\u{1100}-\u{115f}\u{2e80}-\u{303e}\u{3041}-\u{33ff}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{a000}-\u{a4cf}\u{ac00}-\u{d7a3}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{1f004}\u{1f0cf}\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{3fffd}]/u;

/** The columns `text` takes in a terminal, for wrapping: not its length in UTF-16 units. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += ZERO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
  return width;
}

/** Shown to a person. Windows uses native separators; any other platform is unchanged. */
export function displayPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path.replaceAll('/', '\\');
}

/**
 * A reader closing early (`repown help | head -3`) delivers EPIPE on the next
 * write. That is the reader's choice, not a fault in repown, so the write is
 * dropped rather than left to crash with a stack trace -- and NOTHING ELSE
 * changes. In particular the exit code stands: `git push 2>&1 | true` closes the
 * hook's stderr, and turning that into exit 0 published the commit it refused.
 */
export function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') throw error;
    });
  }
}
