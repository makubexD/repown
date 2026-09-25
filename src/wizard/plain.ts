// The wizard drawn with plain lines: numbered choices, words instead of symbols, no
// colour needed. Used when the richer prompter can't be (TERM=dumb, or @clack/prompts
// fails to load) and by the tests, which drive it through ordinary streams.
//
// Everything goes to the output stream it's given -- stderr in real use -- so stdout
// keeps carrying only what the commands themselves print. End of input or Ctrl-C at a
// question is a cancel, never an answer.

import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { BACK, CANCEL, type Answer, type Choice, type Prompter, type Reply, type Review, type ReviewChoice, type Step } from './engine.ts';

export interface Streams {
  readonly input: Readable;
  readonly output: Writable;
}

/** Typed at a text question, it means "go back" (never used for a real answer here). */
export const BACK_WORD = '<';

const REVIEW: readonly (readonly [ReviewChoice, string])[] = [
  ['run', 'Run these commands'], ['back', 'Back'], ['edit', 'Change an answer'], ['decline', 'Decline'],
];

export function plainPrompter(streams: Streams): Prompter {
  // On a real terminal, readline must own it: only then does Ctrl-C arrive as its
  // SIGINT event (a cancel) instead of ending the process with a signal.
  const terminal = (streams.input as { isTTY?: boolean }).isTTY === true;
  const rl = createInterface({ input: streams.input, output: streams.output, terminal });
  const io = ioFor(rl, streams.output, terminal);
  return {
    ask: (step, initial, choices, detail) => askStep(io, step, { initial, choices, detail }),
    review: (review) => showReview(io, review),
    pickStep: async (steps) => {
      io.say('Which answer do you want to change?');
      const index = await pickNumber(io, steps.map((step) => step.message), 1);
      return index === CANCEL ? CANCEL : steps[index]!.id;
    },
    note: (message) => io.say('  ' + message),
    close: () => rl.close(),
  };
}

type Next = () => Promise<string | null>;

interface Io {
  readonly lines: Next;
  /** Shows the text the answer is typed after; readline redraws it while the line is edited. */
  readonly write: (text: string) => void;
  readonly say: (text: string) => void;
}

/** On a terminal, readline shows the prompt, so it can redraw it while the line is edited. */
function ioFor(rl: Interface, output: Writable, terminal: boolean): Io {
  const lines = queue(rl);
  let closed = false;
  rl.on('close', () => { closed = true; });
  const write = (text: string): void => { output.write(text); };
  const show = (text: string): void => {
    if (!terminal || closed) { write(text); return; }
    rl.setPrompt(text);
    rl.prompt();
  };
  return { lines, write: show, say: (text) => write(text + '\n') };
}

/** The input as a queue of lines; null once it has ended or Ctrl-C was pressed. */
function queue(rl: Interface): Next {
  const waiting: ((line: string | null) => void)[] = [];
  const buffered: (string | null)[] = [];
  const push = (line: string | null): void => { const take = waiting.shift(); if (take) take(line); else buffered.push(line); };
  rl.on('line', (line) => push(line));
  rl.on('close', () => push(null));
  rl.on('SIGINT', () => { push(null); rl.close(); });
  return () => {
    if (buffered.length > 0) return Promise.resolve(buffered[0] === null ? null : buffered.shift()!);
    return new Promise((resolve) => waiting.push(resolve));
  };
}

interface Asked {
  readonly initial: Answer | undefined;
  readonly choices: readonly Choice[];
  readonly detail: string | undefined;
}

async function askStep(io: Io, step: Step<never>, { initial, choices, detail }: Asked): Promise<Reply> {
  io.say(step.message + (step.hint ? '  (' + step.hint + ')' : ''));
  if (detail) io.say('  ' + detail);
  if (step.kind === 'select') return askSelect(io, choices, initial);
  if (step.kind === 'confirm') return askConfirm(io, initial === true);
  const shown = typeof initial === 'string' && initial ? ' [' + initial + ']' : '';
  io.say('  type ' + BACK_WORD + ' to go back');
  const line = await prompt(io, '  >' + shown + ' ');
  if (line === null) return CANCEL;
  if (line === BACK_WORD) return BACK;
  return line || (typeof initial === 'string' ? initial : '');
}

async function askSelect(io: Io, choices: readonly Choice[], initial: Answer | undefined): Promise<Reply> {
  const labels = choices.map((choice) => choice.label + (choice.hint ? '  -- ' + choice.hint : ''));
  const current = choices.findIndex((choice) => choice.value === initial);
  const index = await pickNumber(io, [...labels, 'Back'], current >= 0 ? current + 1 : 1);
  if (index === CANCEL) return CANCEL;
  return index === choices.length ? BACK : choices[index]!.value;
}

async function askConfirm(io: Io, yes: boolean): Promise<Reply> {
  const index = await pickNumber(io, ['Yes', 'No', 'Back'], yes ? 1 : 2);
  if (index === CANCEL) return CANCEL;
  return index === 2 ? BACK : index === 0;
}

async function showReview(io: Io, review: Review): Promise<ReviewChoice> {
  io.say('');
  io.say('Review -- nothing has changed yet');
  for (const line of review.summary) io.say('  ' + line);
  io.say('');
  io.say('This runs:');
  for (const command of review.commands) io.say('  ' + command);
  io.say('');
  const index = await pickNumber(io, REVIEW.map(([, label]) => label), 1);
  return index === CANCEL ? CANCEL : REVIEW[index]![0];
}

/** Lists numbered options and reads a number until it's valid; Enter takes the default. */
async function pickNumber(io: Io, labels: readonly string[], preset: number): Promise<number | typeof CANCEL> {
  labels.forEach((label, index) => io.say('  ' + (index + 1) + ') ' + label));
  for (;;) {
    const line = await prompt(io, '  choice [' + preset + ']: ');
    if (line === null) return CANCEL;
    const picked = line === '' ? preset : Number(line);
    if (Number.isInteger(picked) && picked >= 1 && picked <= labels.length) return picked - 1;
    io.say('  type a number from 1 to ' + labels.length);
  }
}

async function prompt(io: Io, text: string): Promise<string | null> {
  io.write(text);
  const line = await io.lines();
  return line === null ? null : line.trim();
}
