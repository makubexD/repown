// One smoke test of the @clack/prompts adapter, driven through ordinary streams with
// key presses: Enter takes the default, arrows reach "← Back", Esc cancels, and every
// line is drawn on the stream it was given, never on stdout. The key handling is
// clack's own; this only proves the adapter maps it onto the engine's replies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { clackPrompter } from '../src/wizard/clack.ts';
import { BACK, CANCEL, type Prompter, type Step } from '../src/wizard/engine.ts';

const ENTER = '\r';
const DOWN = '\x1b[B';
const ESC = '\x1b';

function press(input: PassThrough, ...keys: string[]): void {
  setTimeout(() => { for (const key of keys) input.write(key); }, 50);
}

const guard = { id: 'guard', kind: 'confirm', message: 'Check every push?', hint: 'undo: repown guard off', flag: '--guard' } as Step<never>;
const name = { id: 'name', kind: 'text', message: 'Commit name', hint: 'shown on every commit', flag: '--name' } as Step<never>;

test('the clack prompter answers the engine through its own keys, on the given stream', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter: Prompter = clackPrompter({ input, output });
  const writes: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
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
