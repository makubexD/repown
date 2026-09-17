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

function useColour(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
}

function paint(colour: keyof typeof COLOURS, text: string): string {
  return useColour() ? COLOURS[colour] + text + COLOURS.reset : text;
}

function status(word: string, colour: keyof typeof COLOURS, tag: string, message: string): string {
  return paint(colour, word.padEnd(5)) + ' ' + tag.padEnd(10) + ' ' + message;
}

export function pass(tag: string, message: string): void {
  process.stdout.write(status('OK', 'green', tag, message) + '\n');
}

export function warn(tag: string, message: string): void {
  process.stderr.write(status('WARN', 'yellow', tag, message) + '\n');
}

export function fail(tag: string, message: string): void {
  process.stderr.write(status('FAIL', 'red', tag, message) + '\n');
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
  process.stdout.write('\n' + paint('dim', text) + '\n');
}

export function dim(text: string): string {
  return paint('dim', text);
}
