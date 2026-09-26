// The wizard drawn with plain lines: numbered choices, words instead of symbols, no
// colour needed. Used when the richer prompter can't be (NO_COLOR or FORCE_COLOR=0,
// always TERM=dumb, or @clack/prompts fails to load) and by the tests, which drive it
// through ordinary streams.
//
// Everything goes to the output stream it's given -- stderr in real use -- so stdout
// keeps carrying only what the commands themselves print. End of input or Ctrl-C at a
// question is a cancel, never an answer.

import { createInterface, type Interface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { BACK, CANCEL, type Asked, type Prompter, type Reply, type Review, type ReviewChoice, type Step } from './engine.ts';
import { BACK_TO_REVIEW, PICK_QUESTION, reviewDefault, reviewLines, reviewOptions, reviewQuestion } from './review-text.ts';

export interface Streams {
  readonly input: Readable;
  readonly output: Writable;
}

/** Typed at a text question, it means "go back" (never used for a real answer here). */
export const BACK_WORD = '<';

export function plainPrompter(streams: Streams): Prompter {
  // On a real terminal, readline must own it: only then does Ctrl-C arrive as its
  // SIGINT event (a cancel) instead of ending the process with a signal.
  const terminal = (streams.input as { isTTY?: boolean }).isTTY === true;
  const rl = createInterface({ input: streams.input, output: streams.output, terminal });
  const io = ioFor(rl, streams.output, terminal);
  return {
    ask: (step, asked) => askStep(io, step, asked),
    review: (review) => showReview(io, review),
    pickStep: async (steps) => {
      io.say(PICK_QUESTION);
      const index = await pickNumber(io, [...steps.map((step) => step.message), BACK_TO_REVIEW], 1);
      if (index === CANCEL) return CANCEL;
      return index === steps.length ? BACK : steps[index]!.id;
    },
    note: (message) => io.say('  ' + message),
    close: () => rl.close(),
    outro: (message) => io.say(message),
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

async function askStep(io: Io, step: Step<never>, asked: Asked): Promise<Reply> {
  const { initial, detail } = asked;
  io.say(step.message + (step.hint ? '  (' + step.hint + ')' : ''));
  if (detail) io.say('  ' + detail);
  if (step.kind === 'select') return askSelect(io, asked);
  if (step.kind === 'confirm') return askConfirm(io, initial === true, asked.canGoBack);
  const shown = typeof initial === 'string' && initial ? ' [' + initial + ']' : '';
  if (asked.canGoBack) io.say('  type ' + BACK_WORD + ' to go back');
  const line = await prompt(io, '  >' + shown + ' ');
  if (line === null) return CANCEL;
  if (line === BACK_WORD && asked.canGoBack) return BACK;
  return line || (typeof initial === 'string' ? initial : '');
}

async function askSelect(io: Io, { choices, initial, canGoBack }: Asked): Promise<Reply> {
  const labels = choices.map((choice) => choice.label + (choice.hint ? '  -- ' + choice.hint : ''));
  const current = choices.findIndex((choice) => choice.value === initial);
  const index = await pickNumber(io, canGoBack ? [...labels, 'Back'] : labels, current >= 0 ? current + 1 : 1);
  if (index === CANCEL) return CANCEL;
  return index === choices.length ? BACK : choices[index]!.value;
}

async function askConfirm(io: Io, yes: boolean, canGoBack: boolean): Promise<Reply> {
  const index = await pickNumber(io, canGoBack ? ['Yes', 'No', 'Back'] : ['Yes', 'No'], yes ? 1 : 2);
  if (index === CANCEL) return CANCEL;
  return index === 2 ? BACK : index === 0;
}

async function showReview(io: Io, review: Review): Promise<ReviewChoice> {
  io.say('');
  io.say(review.title);
  for (const line of reviewLines(review)) io.say(line ? '  ' + line : '');
  io.say('');
  io.say(reviewQuestion(review));
  const options = reviewOptions(review);
  const preset = options.findIndex((option) => option.value === reviewDefault(review)) + 1;
  const index = await pickNumber(io, options.map((option) => option.label + (option.hint ? '  -- ' + option.hint : '')), preset);
  return index === CANCEL ? CANCEL : options[index]!.value;
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
