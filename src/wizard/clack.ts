// The wizard drawn with @clack/prompts: arrow-key choices with a hint each, defaults,
// a line while state is read, the review in a box. The ONLY file that imports the
// library, and it is loaded with a dynamic import() by `repown setup` alone (ADR-016),
// so no other command -- and never the pre-push hook -- depends on it.
//
// Everything is drawn on the stream it's given (stderr), so stdout keeps carrying only
// what the commands print. Back is the engine's: a "← Back" choice, or `<` typed at a
// text question, offered from the second question on. Esc and Ctrl-C cancel.

import { styleText } from 'node:util';
import * as p from '@clack/prompts';
import { BACK, CANCEL, type Asked, type Drawn, type Prompter, type Reply, type Review, type ReviewChoice } from './engine.ts';
import { BACK_WORD, type Streams } from './plain.ts';
import { BACK_TO_REVIEW, PICK_QUESTION, reviewDefault, reviewLines, reviewOptions, reviewQuestion, textWidth, wrap } from './review-text.ts';

/** A value no real choice can have. */
const GO_BACK = '\u0000back';

export function clackPrompter(streams: Streams): Prompter {
  const io = { input: streams.input, output: streams.output };
  return {
    ask: (step, asked) => {
      if (asked.detail) p.log.info(wrap(asked.detail, widthOf(io, GUTTER)).join('\n'), io);
      return askStep(step, asked, io);
    },
    review: (review) => showReview(review, io),
    pickStep: async (steps) => {
      const id = await p.select({ ...io, message: PICK_QUESTION,
        options: [...steps.map((step) => ({ value: step.id, label: step.message })), { value: GO_BACK, label: '← ' + BACK_TO_REVIEW }] });
      if (p.isCancel(id)) return CANCEL;
      return id === GO_BACK ? BACK : id;
    },
    note: (message) => p.log.warn(wrap(message, widthOf(io, GUTTER)).join('\n'), io),
    close: () => {},
    intro: (title) => p.intro(title, io),
    // After a cancel, clack has already drawn the gutter's last line.
    outro: (message, cancelled) => (cancelled ? p.cancel(message, io) : p.outro(message, io)),
    // A line, not clack's spinner: the spinner takes over Ctrl-C and exits 0, where a
    // cancel must exit 130.
    busy: (message) => p.log.step(message, io),
  };
}

type Io = { readonly input: Streams['input']; readonly output: Streams['output'] };

/**
 * Columns to leave free. clack wraps a list question 13 columns short of the window and
 * a box's text 6 short, but never a text question's hint or a log line; wrapping every
 * one here, within those widths, keeps them all in the gutter and none wrapped twice.
 */
const GUTTER = 13;
const BOX = 6;

function widthOf(io: Io, margin: number): number {
  return textWidth((io.output as { columns?: number }).columns, margin);
}

function askStep(step: Drawn, asked: Asked, io: Io): Promise<Reply> {
  if (step.kind === 'select') return askSelect(step, asked, io);
  if (step.kind === 'confirm') return askConfirm(step, asked, io);
  return askText(step, asked, io);
}

/** "← Back", unless this is the first question asked and there is nowhere to go. */
function backOption(asked: Asked): { value: string; label: string; hint: string }[] {
  return asked.canGoBack ? [{ value: GO_BACK, label: '← Back', hint: 'to the previous question' }] : [];
}

async function askSelect(step: Drawn, asked: Asked, io: Io): Promise<Reply> {
  const options = [...asked.choices.map((choice) => ({ ...choice })), ...backOption(asked)];
  const preset = typeof asked.initial === 'string' ? { initialValue: asked.initial } : {};
  const value = await p.select<string>({ ...io, ...preset, message: messageOf(step, io), options });
  if (p.isCancel(value)) return CANCEL;
  return value === GO_BACK ? BACK : value;
}

async function askConfirm(step: Drawn, asked: Asked, io: Io): Promise<Reply> {
  const value = await p.select({ ...io, message: messageOf(step, io), initialValue: asked.initial === true ? 'yes' : 'no',
    options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, ...backOption(asked)] });
  if (p.isCancel(value)) return CANCEL;
  return value === GO_BACK ? BACK : value === 'yes';
}

async function askText(step: Drawn, asked: Asked, io: Io): Promise<Reply> {
  const preset = typeof asked.initial === 'string' ? { initialValue: asked.initial } : {};
  const extra = asked.canGoBack ? 'type ' + BACK_WORD + ' to go back' : undefined;
  const value = await p.text({ ...io, ...preset, message: messageOf(step, io, extra),
    validate: (typed) => (isBack(typed, asked) ? undefined : step.validate?.((typed ?? '').trim()) ?? undefined) });
  if (p.isCancel(value)) return CANCEL;
  return isBack(value, asked) ? BACK : value.trim();
}

/** `<` means back only where there is somewhere to go; on the first question it is just text. */
function isBack(typed: string | undefined, asked: Asked): boolean {
  return asked.canGoBack && typed?.trim() === BACK_WORD;
}

/**
 * clack draws its gutter in front of a select's second line but not a text prompt's,
 * so a text question draws it itself.
 */
const TEXT_GUTTER = styleText('gray', '│') + '  ';

/** The question, and under it the hint, wrapped in the gutter -- visible whatever the answer shows. */
function messageOf(step: Drawn, io: Io, extra?: string): string {
  const hint = [step.hint, extra].filter((part) => part).join(' · ');
  const gutter = step.kind === 'text' ? TEXT_GUTTER : '';
  return [step.message, ...(hint ? wrap(hint, widthOf(io, GUTTER)) : [])].join('\n' + gutter);
}

async function showReview(review: Review, io: Io): Promise<ReviewChoice> {
  p.note(reviewLines(review, widthOf(io, BOX), (text) => styleText('dim', text)).join('\n'), review.title, io);
  const choice = await p.select({ ...io, message: reviewQuestion(review), options: reviewOptions(review),
    initialValue: reviewDefault(review) });
  return p.isCancel(choice) ? CANCEL : choice;
}
