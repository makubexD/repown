// One smoke test of the @clack/prompts adapter, driven through ordinary streams with
// key presses: Enter takes the default, arrows reach "← Back", Esc cancels, and every
// line is drawn on the stream it was given, never on stdout. The key handling is
// clack's own; this only proves the adapter maps it onto the engine's replies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { clackPrompter } from '../src/wizard/clack.ts';
import { BACK, CANCEL, type Drawn, type Prompter } from '../src/wizard/engine.ts';
import { COMMAND_MARK, labelOf, stepConfirmLines, wrap } from '../src/wizard/review-text.ts';

const ENTER = '\r';
const DOWN = '\x1b[B';
const ESC = '\x1b';

function press(input: PassThrough, ...keys: string[]): void {
  setTimeout(() => { for (const key of keys) input.write(key); }, 50);
}

const guard = { id: 'guard', kind: 'confirm', message: 'Check every push?', hint: 'undo: repown guard off', flag: '--guard' } as Drawn;
const name = { id: 'name', kind: 'text', message: 'Commit name', hint: 'shown on every commit', flag: '--name' } as Drawn;

test('after a cancel the closing line follows clack\'s own last gutter line, not a second one', () => {
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = clackPrompter({ input: new PassThrough(), output });
  const plain = (): string => shown.replace(/\x1b\[[0-9;]*m/g, '');
  prompter.outro?.('Cancelled: nothing was changed.', true);
  assert.doesNotMatch(plain(), /│/);
  assert.match(plain(), /└ {2}Cancelled: nothing was changed\./);
  shown = '';
  prompter.outro?.('Running the commands');
  assert.match(plain(), /│\n└ {2}Running the commands/);
});

test('show draws each line after the gutter', () => {
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = clackPrompter({ input: new PassThrough(), output });
  prompter.show?.(['Accounts   1 recorded: octocat', 'Clones     2 below this folder']);
  const plain = shown.replace(/\x1b\[[0-9;]*m/g, '');
  for (const text of ['Accounts   1 recorded: octocat', 'Clones     2 below this folder']) {
    const found = plain.split('\n').filter((line) => line.includes(text));
    assert.ok(found.length > 0, plain);
    for (const line of found) assert.match(line, /^│/, line);
  }
});

test('the clack prompter answers the engine through its own keys, on the given stream', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter: Prompter = clackPrompter({ input, output });
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // Recorded and passed on: swallowing stdout would swallow the test runner's own reports too.
  process.stdout.write = ((chunk: string, ...rest: never[]) => { writes.push(String(chunk)); return realWrite(chunk, ...rest); }) as typeof process.stdout.write;
  try {
    // No spinner: clack's takes over Ctrl-C and exits 0, where a cancel must be 130.
    prompter.busy?.('Reading this clone');
    assert.doesNotMatch(shown, /[◒◐◓◑]/);
    press(input, ENTER);
    assert.equal(await prompter.ask(guard, { initial: true, choices: [], detail: 'only your address is in this history', canGoBack: true }), true);
    press(input, ENTER);
    assert.equal(await prompter.ask(name, { initial: '  Octo Cat ', choices: [], detail: undefined, canGoBack: true }), 'Octo Cat', 'answers are trimmed, as in the plain prompter');
    press(input, DOWN, DOWN, ENTER);
    assert.equal(await prompter.ask(guard, { initial: true, choices: [], detail: undefined, canGoBack: true }), BACK);
    press(input, ESC);
    assert.equal(await prompter.ask(guard, { initial: true, choices: [], detail: undefined, canGoBack: true }), CANCEL);
    press(input, ENTER);
    assert.equal(await prompter.review({ title: 'Review: nothing has changed yet', headline: [], notes: [], settled: false, steps: [{ what: 'Pin this clone to octocat', command: 'repown use octocat', detail: [] }] }), 'run');
  } finally {
    process.stdout.write = realWrite;
  }
  assert.match(shown, /Check every push\?/);
  assert.match(shown, /undo: repown guard off/, 'the hint shows under the question');
  assert.match(shown, /shown on every commit · type < to go back/, 'a text question shows its hint even with a default');
  assert.match(shown, /only your address is in this history/);
  assert.match(shown, /repown use octocat/);
  assert.deepEqual(writes.filter((text) => /Check every push|repown use/.test(text)), [], 'nothing drawn on stdout');
});

/** clack and repown style through node:util's styleText, which a test stream only gets when colour is forced. */
function withColour(run: () => void): void {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '1';
  try { run(); } finally {
    if (saved === undefined) delete process.env['FORCE_COLOR']; else process.env['FORCE_COLOR'] = saved;
  }
}

function drawn(draw: (prompter: Prompter) => void): string {
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  draw(clackPrompter({ input: new PassThrough(), output }));
  return shown;
}

const ANSI = /\x1b\[[0-9;]*m/g;

test('with colour the title is a badge, a label\'s value is bold cyan and a command cyan; the words are unchanged', () => {
  withColour(() => {
    const title = drawn((prompter) => prompter.intro?.('repown setup'));
    assert.match(title, /\x1b\[46m.*repown setup/);
    const lines = ['Accounts   1 recorded: octocat', 'plain words stay as they are', '$ repown use octocat'];
    const shown = drawn((prompter) => prompter.show?.(lines));
    assert.match(shown, /Accounts {3}\x1b\[1m\x1b\[36m1 recorded: octocat/);
    assert.match(shown, /\x1b\[36m\$ repown use octocat/);
    assert.doesNotMatch(shown, /\x1b\[[0-9;]*mplain words/);
    const plain = shown.replace(ANSI, '');
    for (const text of lines) assert.ok(plain.includes(text), plain);
  });
});

test('without colour the title is exactly as before, unpadded', () => {
  const saved = process.env['FORCE_COLOR'];
  process.env['FORCE_COLOR'] = '0';
  try {
    assert.match(drawn((prompter) => prompter.intro?.('repown setup')), /^(┌|T) {2}repown setup\n$/, 'clack draws T where Unicode can\'t be drawn');
  } finally {
    if (saved === undefined) delete process.env['FORCE_COLOR']; else process.env['FORCE_COLOR'] = saved;
  }
});

test('a wrapped value keeps its colour on the continuation line, at the same width as without colour', () => {
  const long = 'Clones     ' + Array.from({ length: 14 }, (_, index) => 'clone' + index).join(', ');
  const plainRun = drawn((prompter) => prompter.show?.([long]));
  let coloured = '';
  withColour(() => { coloured = drawn((prompter) => prompter.show?.([long])); });
  assert.equal(coloured.replace(ANSI, ''), plainRun.replace(ANSI, ''));
  const rows = coloured.split('\n').filter((row) => row.includes('clone'));
  assert.ok(rows.length > 1, coloured);
  for (const row of rows) assert.match(row, /\x1b\[36m/, row);
});

test('labelOf names the column wrap hangs under, and nothing for a numbered or indented line', () => {
  const label = 'Accounts   2 recorded: octo-work, octocat, and a few more names to make it wrap';
  assert.equal(labelOf(label), 'Accounts   ');
  assert.equal(wrap(label, 40)[1]!.length - wrap(label, 40)[1]!.trimStart().length, 'Accounts   '.length);
  assert.equal(labelOf('1. Pin  this clone to octocat'), '');
  assert.equal(labelOf('  user.name:  Octo Cat'), '');
  assert.equal(labelOf('plain words stay as they are'), '');
});

test('a wrapped command is cyan on every row', () => {
  const command = '$ repown use octocat --name="Octo Cat" --email=octocat@users.noreply.example.invalid --guard --auto-upstream';
  let coloured = '';
  withColour(() => { coloured = drawn((prompter) => prompter.show?.([command])); });
  const rows = coloured.split('\n').filter((row) => /octocat|guard|upstream/.test(row));
  assert.ok(rows.length > 1, coloured);
  for (const row of rows) assert.match(row, /\x1b\[36m/, row);
});

test('the start screen\'s hand-over line closes the frame in cyan; a plain closing line is not styled', () => {
  withColour(() => {
    assert.match(drawn((prompter) => prompter.outro?.('$ repown setup --cwd code')), /\x1b\[36m\$ repown setup --cwd code/);
    assert.doesNotMatch(drawn((prompter) => prompter.outro?.('> repown setup')), /\x1b\[36m/, '> is no longer the mark');
    assert.doesNotMatch(drawn((prompter) => prompter.outro?.('Running the commands')), /\x1b\[36m/);
  });
});

test('a command drawn to copy starts with $, which pasted whole is a harmless error, never a redirect', () => {
  assert.equal(COMMAND_MARK, '$ ');
  assert.equal(stepConfirmLines({ changes: ['a change'], why: 'why', command: 'repown fix' }).at(-1), '$ repown fix');
});

/** No sign of a Unicode terminal: clack then draws its ASCII frame (Windows needs every signal unset, elsewhere TERM=linux). */
function asciiEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
  for (const key of ['CI', 'WT_SESSION', 'TERMINUS_SUBLIME', 'ConEmuTask', 'TERM_PROGRAM', 'TERM', 'TERMINAL_EMULATOR']) delete env[key];
  if (process.platform !== 'win32') env['TERM'] = 'linux';
  return env;
}

const ASK_TEXT = `
  import { PassThrough } from 'node:stream';
  import { clackPrompter } from ${JSON.stringify(new URL('../src/wizard/clack.ts', import.meta.url).href)};
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => { shown += chunk.toString(); });
  setTimeout(() => input.write('\\r'), 50);
  await clackPrompter({ input, output }).ask(
    { id: 'name', kind: 'text', message: 'Commit name', hint: 'shown on every commit', flag: '--name' },
    { initial: 'Octo Cat', choices: [], detail: undefined, canGoBack: true });
  process.stderr.write(shown);
`;

test('in a terminal without Unicode, a text question\'s hint lines use clack\'s ASCII gutter too', () => {
  const run = spawnSync(process.execPath, ['--input-type=module'], { input: ASK_TEXT, env: asciiEnv(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^\| {2}shown on every commit · type < to go back$/m);
  assert.doesNotMatch(run.stderr, /[│┌└◆◇]/u, run.stderr);
});

test('"type < to go back" is never split across lines; it takes a line of its own when it doesn\'t fit', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 37 });
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const long = { ...name, hint: 'one two three four five six seven' } as Drawn;
  press(input, ENTER);
  await clackPrompter({ input, output }).ask(long, { initial: 'Octo Cat', choices: [], detail: undefined, canGoBack: true });
  const plain = shown.replace(ANSI, '');
  assert.match(plain, /^.\s+six seven$/m, plain);
  assert.match(plain, /^.\s+type < to go back$/m, plain);
});

test('a detail is drawn in its question\'s block, under the hint and before "type < to go back", never above it', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80 });
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  press(input, ENTER);
  await clackPrompter({ input, output }).ask(name, { initial: 'Octo Cat', choices: [], detail: 'GitHub shows no name for octocat', canGoBack: true });
  const plain = shown.replace(ANSI, '');
  const at = (text: string): number => plain.indexOf(text);
  assert.ok(at(name.message) >= 0 && at(name.message) < at('shown on every commit'), plain);
  assert.ok(at('shown on every commit') < at('GitHub shows no name'), plain);
  assert.ok(at('GitHub shows no name') < at('type < to go back'), plain);
  assert.doesNotMatch(plain, /[●•]\s+GitHub shows no name/, 'not a log line of its own');
});
