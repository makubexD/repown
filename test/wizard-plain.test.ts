// The plain prompter, fed through ordinary streams: numbered choices, `<` for back on
// a text question, Enter for the default, and end of input as a cancel.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { plainPrompter } from '../src/wizard/plain.ts';
import { BACK, CANCEL, type Prompter, type Step } from '../src/wizard/engine.ts';

interface Harness {
  readonly prompter: Prompter;
  readonly shown: () => string;
}

function harness(typed: string, end = true): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => { text += chunk.toString(); });
  input.write(typed);
  if (end) input.end();
  return { prompter: plainPrompter({ input, output }), shown: () => text };
}

const text: Step<never> = { id: 'name', kind: 'text', message: 'Commit name', hint: 'shown on every commit', flag: '--name' };
const pick: Step<never> = { id: 'account', kind: 'select', message: 'Which account?', hint: '', flag: '<account>' };
const yesNo: Step<never> = { id: 'guard', kind: 'confirm', message: 'Check every push?', hint: '', flag: '--guard' };
const CHOICES = [{ value: 'octocat', label: 'octocat', hint: 'recorded' }, { value: '', label: 'a new account' }];

describe('plain prompter', () => {
  test('a text question takes the typed value, or the default on Enter', async () => {
    const typed = harness('Octo Cat\n\n');
    assert.equal(await typed.prompter.ask(text, 'x', []), 'Octo Cat');
    assert.equal(await typed.prompter.ask(text, 'Octo', []), 'Octo');
    assert.match(typed.shown(), /Commit name {2}\(shown on every commit\)/);
    assert.match(typed.shown(), /\[Octo\]/);
  });

  test('< on a text question means back', async () => {
    assert.equal(await harness('<\n').prompter.ask(text, undefined, []), BACK);
  });

  test('a select lists numbered choices plus Back, and re-asks on a bad number', async () => {
    const run = harness('9\n2\n');
    assert.equal(await run.prompter.ask(pick, undefined, CHOICES), '');
    assert.match(run.shown(), /1\) octocat {2}-- recorded/);
    assert.match(run.shown(), /3\) Back/);
    assert.match(run.shown(), /type a number from 1 to 3/);
    assert.equal(await harness('3\n').prompter.ask(pick, undefined, CHOICES), BACK);
    assert.equal(await harness('\n').prompter.ask(pick, 'octocat', CHOICES), 'octocat');
  });

  test('a confirm is Yes / No / Back, defaulting to the initial answer', async () => {
    assert.equal(await harness('\n').prompter.ask(yesNo, true, []), true);
    assert.equal(await harness('\n').prompter.ask(yesNo, false, []), false);
    assert.equal(await harness('1\n').prompter.ask(yesNo, false, []), true);
    assert.equal(await harness('3\n').prompter.ask(yesNo, true, []), BACK);
  });

  test('the review shows the commands and returns the choice', async () => {
    const run = harness('3\n');
    assert.equal(await run.prompter.review({ summary: ['account  octocat'], commands: ['repown use octocat'] }), 'edit');
    assert.match(run.shown(), /nothing has changed yet/);
    assert.match(run.shown(), /repown use octocat/);
    assert.equal(await harness('\n').prompter.review({ summary: [], commands: [] }), 'run');
  });

  test('end of input cancels, at a question, a choice or the review', async () => {
    assert.equal(await harness('').prompter.ask(text, 'x', []), CANCEL);
    assert.equal(await harness('').prompter.ask(pick, undefined, CHOICES), CANCEL);
    assert.equal(await harness('').prompter.review({ summary: [], commands: [] }), CANCEL);
    assert.equal(await harness('').prompter.pickStep([text]), CANCEL);
  });

  test('change an answer picks one of the steps by number', async () => {
    assert.equal(await harness('2\n').prompter.pickStep([text, pick]), 'account');
  });
});
