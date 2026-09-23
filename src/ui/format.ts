// Terminal output. Deliberately plain: a fixed-width status word, a short tag
// saying which check spoke, then the message.
//
//   OK    identity   octocat <...>  push-as:octocat
//   WARN  gh         active as someone else, so `gh pr create` would act as them
//         fix: gh auth switch -u octocat

const COLOURS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

/**
 * Colour is a property of the STREAM a line goes to, not of the process: piping
 * stdout into a file while stderr stays a terminal (`repown 2>&1 | less`, or the
 * reverse, `repown 2>err.log`) must not colour the redirected side. `NO_COLOR`
 * only counts when it is non-empty, and `FORCE_COLOR=0`/`false` turns colour
 * off even though the variable is set -- both per the NO_COLOR/FORCE_COLOR
 * conventions these variables are named after.
 */
function useColour(stream: NodeJS.WriteStream): boolean {
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  if (process.env['NO_COLOR']) return false;
  return stream.isTTY === true;
}

function paint(stream: NodeJS.WriteStream, colour: keyof typeof COLOURS, text: string): string {
  return useColour(stream) ? COLOURS[colour] + text + COLOURS.reset : text;
}

function status(stream: NodeJS.WriteStream, word: string, colour: keyof typeof COLOURS, tag: string, message: string): string {
  return paint(stream, colour, word.padEnd(5)) + ' ' + tag.padEnd(10) + ' ' + message;
}

export function pass(tag: string, message: string): void {
  process.stdout.write(status(process.stdout, 'OK', 'green', tag, message) + '\n');
}

export function warn(tag: string, message: string): void {
  process.stderr.write(status(process.stderr, 'WARN', 'yellow', tag, message) + '\n');
}

export function fail(tag: string, message: string): void {
  process.stderr.write(status(process.stderr, 'FAIL', 'red', tag, message) + '\n');
}

/** A continuation line under a warn or fail, aligned with its message column. */
export function detail(message: string): void {
  process.stderr.write('       ' + message + '\n');
}

export function line(message = ''): void {
  process.stdout.write(message + '\n');
}

/** `  label      value` -- the shape every status block uses. */
export function field(label: string, value: string, width = 14): void {
  process.stdout.write('  ' + label.padEnd(width) + ' ' + value + '\n');
}

export function heading(text: string): void {
  process.stdout.write('\n' + paint(process.stdout, 'dim', text) + '\n');
}

export function dim(text: string): string {
  return paint(process.stdout, 'dim', text);
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
