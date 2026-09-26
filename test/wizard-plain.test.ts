// The plain prompter, fed through ordinary streams: numbered choices, `<` for back on
// a text question, Enter for the default, and end of input as a cancel.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { plainPrompter } from '../src/wizard/plain.ts';
import { BACK, CANCEL, type Answer, type Asked, type Choice, type Prompter, type Review, type Step } from '../src/wizard/engine.ts';

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

const asked = (initial?: Answer, choices: readonly Choice[] = [], canGoBack = true): Asked => ({ initial, choices, detail: undefined, canGoBack });

const text: Step<never> = { id: 'name', kind: 'text', message: 'Commit name', hint: 'shown on every commit', flag: '--name' };
const pick: Step<never> = { id: 'account', kind: 'select', message: 'Which account?', hint: '', flag: '<account>' };
const yesNo: Step<never> = { id: 'guard', kind: 'confirm', message: 'Check every push?', hint: '', flag: '--guard' };
const CHOICES = [{ value: 'octocat', label: 'octocat', hint: 'recorded' }, { value: '', label: 'a new account' }];

const review = (overrides: Partial<Review> = {}): Review => ({
  title: 'Review: nothing has changed yet', headline: ['This clone will commit and push as octocat.'], notes: [], settled: false,
  steps: [{ what: 'Pin this clone to octocat', command: 'repown use octocat', detail: [] }], ...overrides,
});

describe('plain prompter', () => {
  test('a text question takes the typed value, or the default on Enter', async () => {
    const typed = harness('Octo Cat\n\n');
    assert.equal(await typed.prompter.ask(text, asked('x')), 'Octo Cat');
    assert.equal(await typed.prompter.ask(text, asked('Octo')), 'Octo');
    assert.match(typed.shown(), /Commit name {2}\(shown on every commit\)/);
    assert.match(typed.shown(), /\[Octo\]/);
  });

  test('< on a text question means back', async () => {
    assert.equal(await harness('<\n').prompter.ask(text, asked()), BACK);
  });

  test('a select lists numbered choices plus Back, and re-asks on a bad number', async () => {
    const run = harness('9\n2\n');
    assert.equal(await run.prompter.ask(pick, asked(undefined, CHOICES)), '');
    assert.match(run.shown(), /1\) octocat {2}-- recorded/);
    assert.match(run.shown(), /3\) Back/);
    assert.match(run.shown(), /type a number from 1 to 3/);
    assert.equal(await harness('3\n').prompter.ask(pick, asked(undefined, CHOICES)), BACK);
    assert.equal(await harness('\n').prompter.ask(pick, asked('octocat', CHOICES)), 'octocat');
  });

  test('the first question asked offers no Back', async () => {
    const run = harness('3\n1\n');
    assert.equal(await run.prompter.ask(pick, asked(undefined, CHOICES, false)), 'octocat');
    assert.doesNotMatch(run.shown(), /Back/);
    const typed = harness('x\n');
    await typed.prompter.ask(text, asked(undefined, [], false));
    assert.doesNotMatch(typed.shown(), /go back/);
  });

  test('a confirm is Yes / No / Back, defaulting to the initial answer', async () => {
    assert.equal(await harness('\n').prompter.ask(yesNo, asked(true)), true);
    assert.equal(await harness('\n').prompter.ask(yesNo, asked(false)), false);
    assert.equal(await harness('1\n').prompter.ask(yesNo, asked(false)), true);
    assert.equal(await harness('3\n').prompter.ask(yesNo, asked(true)), BACK);
  });

  test('the review numbers each step in plain words, the command under it', async () => {
    const run = harness('3\n');
    assert.equal(await run.prompter.review(review()), 'edit');
    assert.match(run.shown(), /nothing has changed yet/);
    assert.match(run.shown(), /1\. Pin this clone to octocat\n\s+repown use octocat/);
    assert.match(run.shown(), /ordinary repown commands/);
    assert.match(run.shown(), /Run this step\?/);
    assert.equal(await harness('\n').prompter.review(review()), 'run');
  });

  test('a settled review offers Done first', async () => {
    const run = harness('\n');
    assert.equal(await run.prompter.review(review({ settled: true, title: 'This clone is already set up' })), 'done');
    assert.match(run.shown(), /already set up/);
    assert.match(run.shown(), /Apply the same settings again/);
    assert.doesNotMatch(run.shown(), /Decline/);
  });

  test('end of input cancels, at a question, a choice or the review', async () => {
    assert.equal(await harness('').prompter.ask(text, asked('x')), CANCEL);
    assert.equal(await harness('').prompter.ask(pick, asked(undefined, CHOICES)), CANCEL);
    assert.equal(await harness('').prompter.review(review()), CANCEL);
    assert.equal(await harness('').prompter.pickStep([text]), CANCEL);
  });

  test('change an answer picks one of the steps by number, or goes back to the review', async () => {
    assert.equal(await harness('2\n').prompter.pickStep([text, pick]), 'account');
    assert.equal(await harness('3\n').prompter.pickStep([text, pick]), BACK);
  });
});
