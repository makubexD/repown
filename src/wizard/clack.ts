// The wizard drawn with @clack/prompts: arrow-key choices with a hint each, defaults,
// a spinner while state is read, the review in a box. The ONLY file that imports the
// library, and it is loaded with a dynamic import() by `repown setup` alone (ADR-016),
// so no other command -- and never the pre-push hook -- depends on it.
//
// Everything is drawn on the stream it's given (stderr), so stdout keeps carrying only
// what the commands print. Back is the engine's: a "← Back" choice, or `<` typed at a
// text question. Esc and Ctrl-C cancel.

import * as p from '@clack/prompts';
import { BACK, CANCEL, type Answer, type Choice, type Prompter, type Reply, type Review, type ReviewChoice, type Step } from './engine.ts';
import { BACK_WORD, type Streams } from './plain.ts';

/** A value no real choice can have. */
const GO_BACK = '\u0000back';

const REVIEW: readonly { value: ReviewChoice; label: string; hint?: string }[] = [
  { value: 'run', label: 'Run these commands' },
  { value: 'back', label: 'Back', hint: 'to the last question' },
  { value: 'edit', label: 'Change an answer' },
  { value: 'decline', label: 'Decline', hint: 'change nothing' },
];

export function clackPrompter(streams: Streams): Prompter {
  const io = { input: streams.input, output: streams.output };
  return {
    ask: (step, initial, choices, detail) => {
      if (detail) p.log.info(detail, io);
      return askStep(step, { initial, choices }, io);
    },
    review: (review) => showReview(review, io),
    pickStep: async (steps) => {
      const id = await p.select({ ...io, message: 'Which answer do you want to change?',
        options: steps.map((step) => ({ value: step.id, label: step.message })) });
      return p.isCancel(id) ? CANCEL : id;
    },
    note: (message) => p.log.warn(message, io),
    close: () => {},
    intro: (title) => p.intro(title, io),
    outro: (message) => p.outro(message, io),
    // A line, not clack's spinner: the spinner takes over Ctrl-C and exits 0, where a
    // cancel must exit 130.
    busy: (message) => {
      p.log.step(message, io);
      return () => {};
    },
  };
}

type Io = { readonly input: Streams['input']; readonly output: Streams['output'] };

interface Asked {
  readonly initial: Answer | undefined;
  readonly choices: readonly Choice[];
}

function askStep(step: Step<never>, asked: Asked, io: Io): Promise<Reply> {
  if (step.kind === 'select') return askSelect(step, asked, io);
  if (step.kind === 'confirm') return askConfirm(step, asked.initial === true, io);
  return askText(step, asked.initial, io);
}

async function askSelect(step: Step<never>, { initial, choices }: Asked, io: Io): Promise<Reply> {
  const options = [...choices.map((choice) => ({ ...choice })), { value: GO_BACK, label: '← Back' }];
  const preset = typeof initial === 'string' ? { initialValue: initial } : {};
  const value = await p.select<string>({ ...io, ...preset, message: messageOf(step), options });
  if (p.isCancel(value)) return CANCEL;
  return value === GO_BACK ? BACK : value;
}

async function askConfirm(step: Step<never>, yes: boolean, io: Io): Promise<Reply> {
  const value = await p.select({ ...io, message: messageOf(step), initialValue: yes ? 'yes' : 'no',
    options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: GO_BACK, label: '← Back' }] });
  if (p.isCancel(value)) return CANCEL;
  return value === GO_BACK ? BACK : value === 'yes';
}

async function askText(step: Step<never>, initial: Answer | undefined, io: Io): Promise<Reply> {
  const preset = typeof initial === 'string' ? { initialValue: initial } : {};
  const value = await p.text({ ...io, ...preset, message: messageOf(step, 'type ' + BACK_WORD + ' to go back'),
    validate: (typed) => (typed?.trim() === BACK_WORD ? undefined : step.validate?.((typed ?? '').trim()) ?? undefined) });
  if (p.isCancel(value)) return CANCEL;
  return value.trim() === BACK_WORD ? BACK : value.trim();
}

/** The question, and under it the hint -- visible whatever the answer shows. */
function messageOf(step: Step<never>, extra?: string): string {
  const hint = [step.hint, extra].filter((part) => part).join(' · ');
  return hint ? step.message + '\n' + hint : step.message;
}

async function showReview(review: Review, io: Io): Promise<ReviewChoice> {
  p.note([...review.summary, '', 'This runs:', ...review.commands.map((command) => '  ' + command)].join('\n'),
    'Review: nothing has changed yet', io);
  const choice = await p.select({ ...io, message: 'Run these commands?', options: [...REVIEW] });
  return p.isCancel(choice) ? CANCEL : choice;
}

