// The wizard engine, driven by a scripted prompter: no terminal, no prompt library.
// Each script entry is what the user does at the next prompt, and says which prompt
// that must be, so a test fails the moment the engine asks something unexpected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wizard, BACK, CANCEL, type Answer, type Flow, type Prompter, type Reply, type ReviewChoice } from '../src/wizard/engine.ts';

type Entry =
  | readonly ['ask', string, Reply]
  | readonly ['review', ReviewChoice]
  | readonly ['pick', string | typeof CANCEL];

interface Scripted extends Prompter {
  readonly initials: Record<string, Answer | undefined>;
  readonly notes: string[];
  readonly reviews: string[][];
}

function scripted(script: Entry[]): Scripted {
  const queue = [...script];
  const next = (kind: Entry[0], id?: string): Entry => {
    const entry = queue.shift();
    assert.ok(entry, 'the script ran out at ' + kind + (id ? ' ' + id : ''));
    assert.equal(entry[0], kind, 'expected ' + entry[0] + ', the engine asked for ' + kind + ' ' + (id ?? ''));
    if (kind === 'ask') assert.equal(entry[1], id, 'asked the wrong step');
    return entry;
  };
  const prompter: Scripted = {
    initials: {},
    notes: [],
    reviews: [],
    ask: async (step, initial) => { prompter.initials[step.id] = initial; return next('ask', step.id)[2] as Reply; },
    review: async (review) => { prompter.reviews.push([...review.commands]); return next('review')[1] as ReviewChoice; },
    pickStep: async () => next('pick')[1] as string,
    note: (message) => { prompter.notes.push(message); },
    close: () => {},
  };
  return prompter;
}

interface Context { readonly recorded: readonly string[] }

/** account → (name, only for a new account) → guard; the review lists the answers. */
const FLOW: Flow<Context> = {
  steps: [
    { id: 'account', kind: 'text', message: 'Account', hint: '', flag: '<account>',
      validate: (value) => (String(value).trim() ? null : 'a value is required') },
    { id: 'name', kind: 'text', message: 'Name', hint: '', flag: '--name',
      when: (answers, context) => !context.recorded.includes(String(answers['account'])),
      initial: (answers) => String(answers['account']) },
    { id: 'guard', kind: 'confirm', message: 'Guard', hint: '', flag: '--guard', initial: () => true },
  ],
  review: (answers) => ({ summary: [], commands: Object.entries(answers).map(([key, value]) => key + '=' + String(value)) }),
};

const NONE: Context = { recorded: [] };

describe('wizard engine', () => {
  test('asks each reachable step in order, then runs what the review accepted', async () => {
    const prompter = scripted([['ask', 'account', 'octocat'], ['ask', 'name', 'Octo Cat'], ['ask', 'guard', true], ['review', 'run']]);
    assert.deepEqual(await wizard(FLOW, NONE, {}, prompter), { status: 'run', answers: { account: 'octocat', name: 'Octo Cat', guard: true } });
  });

  test('a step whose condition fails is skipped', async () => {
    const prompter = scripted([['ask', 'account', 'octocat'], ['ask', 'guard', false], ['review', 'run']]);
    const outcome = await wizard(FLOW, { recorded: ['octocat'] }, {}, prompter);
    assert.deepEqual(outcome, { status: 'run', answers: { account: 'octocat', guard: false } });
  });

  test('a value given as a flag is never asked', async () => {
    const prompter = scripted([['ask', 'name', 'Octo Cat'], ['ask', 'guard', true], ['review', 'run']]);
    const outcome = await wizard(FLOW, NONE, { account: 'octocat' }, prompter);
    assert.equal(outcome.status, 'run');
  });

  test('Back re-asks the previous step with its earlier answer as the default', async () => {
    const prompter = scripted([
      ['ask', 'account', 'octocat'], ['ask', 'name', 'Octo'], ['ask', 'guard', BACK],
      ['ask', 'name', 'Octo Cat'], ['ask', 'guard', true], ['review', 'run'],
    ]);
    const outcome = await wizard(FLOW, NONE, {}, prompter);
    assert.equal(prompter.initials['name'], 'Octo');
    assert.deepEqual(outcome, { status: 'run', answers: { account: 'octocat', name: 'Octo Cat', guard: true } });
  });

  test('Back at the first step asks it again', async () => {
    const prompter = scripted([['ask', 'account', BACK], ['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', 'run']]);
    assert.equal((await wizard(FLOW, NONE, {}, prompter)).status, 'run');
  });

  test('a refused value is explained and the same step asked again', async () => {
    const prompter = scripted([['ask', 'account', '  '], ['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', 'run']]);
    await wizard(FLOW, NONE, {}, prompter);
    assert.deepEqual(prompter.notes, ['a value is required']);
  });

  test('Back from the review returns to the last step asked, and can keep going back', async () => {
    const prompter = scripted([
      ['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', 'back'],
      ['ask', 'guard', BACK], ['ask', 'name', 'Octo Cat'], ['ask', 'guard', false], ['review', 'run'],
    ]);
    const outcome = await wizard(FLOW, NONE, {}, prompter);
    assert.deepEqual(outcome, { status: 'run', answers: { account: 'octocat', name: 'Octo Cat', guard: false } });
  });

  test('Change an answer re-asks from the chosen step, and a branch that no longer applies is dropped', async () => {
    const prompter = scripted([
      ['ask', 'account', 'new-one'], ['ask', 'name', 'New One'], ['ask', 'guard', true], ['review', 'edit'],
      ['pick', 'account'], ['ask', 'account', 'octocat'], ['ask', 'guard', true], ['review', 'run'],
    ]);
    const outcome = await wizard(FLOW, { recorded: ['octocat'] }, {}, prompter);
    assert.deepEqual(outcome, { status: 'run', answers: { account: 'octocat', guard: true } });
    assert.deepEqual(prompter.reviews[1], ['account=octocat', 'guard=true']);
  });

  test('Decline and cancel end the wizard without running anything', async () => {
    const declined = scripted([['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', 'decline']]);
    assert.deepEqual(await wizard(FLOW, NONE, {}, declined), { status: 'declined' });
    assert.deepEqual(await wizard(FLOW, NONE, {}, scripted([['ask', 'account', CANCEL]])), { status: 'cancelled' });
    const atReview = scripted([['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', CANCEL]]);
    assert.deepEqual(await wizard(FLOW, NONE, {}, atReview), { status: 'cancelled' });
    const atPick = scripted([['ask', 'account', 'octocat'], ['ask', 'name', 'x'], ['ask', 'guard', true], ['review', 'edit'], ['pick', CANCEL]]);
    assert.deepEqual(await wizard(FLOW, NONE, {}, atPick), { status: 'cancelled' });
  });

  test('with every value given, Back at the review shows the review again', async () => {
    const prompter = scripted([['review', 'back'], ['review', 'run']]);
    const outcome = await wizard(FLOW, NONE, { account: 'octocat', name: 'x', guard: true }, prompter);
    assert.equal(outcome.status, 'run');
  });
});
