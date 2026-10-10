// The words around a review, shared by both prompters so the plain and the drawn
// screens say the same thing: the numbered steps, the closing lines, the question, its
// choices and which one Enter takes, and "Change an answer". What goes IN the review
// comes from the flow (setup-flow.ts).

import type { Review, ReviewChoice, StepChoice } from './engine.ts';
import { displayWidth } from '../ui/format.ts';

export interface ReviewOption {
  readonly value: Exclude<ReviewChoice, symbol>;
  readonly label: string;
  readonly hint?: string;
}

/** "Change an answer": the question, and the choice that returns to the review. */
export const PICK_QUESTION = 'Which answer do you want to change?';
export const BACK_TO_REVIEW = 'Back to the review';
export const RUN_THIS_STEP = 'Run this step?';

/** Yes, unless the command changes the whole machine or rewrites commits: that needs a deliberate yes, as in the review. */
export function stepDefault(command: string): 'yes' | 'skip' {
  return needsDeliberateYes(command) ? 'skip' : 'yes';
}

export function stepOptions(): Array<{ value: StepChoice; label: string }> {
  return [
    { value: 'yes', label: 'Yes' },
    { value: 'skip', label: 'Skip' },
    { value: 'stop', label: 'Stop' },
  ];
}

/**
 * What starts a command line drawn to copy. Not `>`: pasted whole, that is a redirect in
 * every shell and leaves a file named `repown`; `$` there is only a harmless error.
 */
export const COMMAND_MARK = '$ ';

/** What a step changes, why, and the command, in that order. */
export function stepConfirmLines(brief: { readonly changes: readonly string[]; readonly why: string; readonly command: string }): string[] {
  return [...brief.changes, '', brief.why, COMMAND_MARK + brief.command];
}

/** `fix` changes the whole machine; `reauthor` rewrites commits. */
function needsDeliberateYes(command: string): boolean {
  return command.startsWith('repown fix') || command.startsWith('repown reauthor');
}

/** A settled clone's verdict: its settings are right; the notes say what else is not (ADR-026). */
function settledVerdict(review: Review): string {
  return review.blocked ? 'Its settings need no change, but the next push will fail:' : 'Nothing needs to change.';
}

/**
 * The body of the review, line by line, wrapped to `width`. `command` styles each
 * command line (cyan where the prompter can draw colour, ADR-027), so a command never
 * reads as one of the plain words around it.
 */
export function reviewLines(review: Review, width = Infinity, command: (text: string) => string = (text) => text): string[] {
  const words = (text: string): string[] => wrap(text, width);
  // A command's continuation sits deeper, so it can't read as the next command.
  const code = (text: string): string[] => wrap('     ' + text, width - 2).map((line, index) => command(index ? '  ' + line : line));
  if (review.settled) return [...review.headline.flatMap(words), '', settledVerdict(review), ...notesOf(review).flatMap(words)];
  const steps = review.steps.flatMap((step, index) => [
    ...words((index + 1) + '. ' + step.what),
    ...code(step.command),
    ...step.detail.flatMap(code),
  ]);
  return [...review.headline.flatMap(words), '', 'When you choose Run:', ...steps, ...notesOf(review).flatMap(words), '',
    ...words('These are ordinary commands: run them yourself, or in a script.'),
    ...words('This clone\'s settings go in its .git/config, which is never pushed.')];
}

/** The widest a line of text gets, however wide the window: longer lines are hard to read. */
export const MAX_WIDTH = 72;

/** The text width for a window `columns` wide, less `margin` for borders and gutters. */
export function textWidth(columns: number | undefined, margin: number): number {
  return Math.max(24, Math.min(MAX_WIDTH, (columns ?? 80) - margin));
}

/**
 * What a wrapped line's continuation hangs under: any indent, then a "1. " step number or
 * a "label   " column (one or two words, then two spaces or more). Group 1 is the label.
 */
const HANG = /^\s*(?:\d+\. |(\S+(?: \S+)? {2,}(?=\S)))?/;

/** The label column of a `label   value` line, padding included; '' for any other line. */
export function labelOf(text: string): string {
  const found = HANG.exec(text)!;
  return found[1] !== undefined && found[0] === found[1] ? found[1] : '';
}

/**
 * One line, wrapped at spaces to `width`. Continuation lines line up under the text:
 * past any indent, a "1. " step number, or a "label   " column.
 */
export function wrap(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  const hang = ' '.repeat(displayWidth(HANG.exec(text)![0]));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/(?<=\S) (?=\S)/)) {
    if (line && displayWidth(line) + 1 + displayWidth(word) > width) { lines.push(line); line = hang + word.trimStart(); }
    else line = line ? line + ' ' + word : word;
  }
  return [...lines, line];
}

function notesOf(review: Review): string[] {
  return review.notes.length > 0 ? ['', ...review.notes] : [];
}

export function reviewQuestion(review: Review): string {
  if (review.settled) return 'What now?';
  return review.steps.length === 1 ? RUN_THIS_STEP : 'Run these ' + review.steps.length + ' steps?';
}

export function reviewOptions(review: Review): ReviewOption[] {
  if (review.settled) return settledOptions(review);
  return [
    { value: 'run', label: review.steps.length === 1 ? 'Run it' : 'Run them' },
    { value: 'back', label: 'Back', hint: 'to the last question' },
    { value: 'edit', label: 'Change an answer' },
    { value: 'decline', label: 'Decline', hint: 'change nothing and exit' },
  ];
}

/** Done, then a way to pick another account, sign in to gh or re-author. Change an answer stays once questions were asked. */
function settledOptions(review: Review): ReviewOption[] {
  const options: ReviewOption[] = [
    { value: 'done', label: 'Done', hint: 'change nothing' },
    { value: 'account', label: 'Use another account', hint: 'choose a different account for this clone' },
  ];
  if (review.ghSignIn) options.push({ value: 'gh', label: review.ghSignIn });
  if (review.reauthorOffer) options.push({ value: 'reauthor', label: review.reauthorOffer, hint: 'only if you made them; a backup is kept' });
  if (review.edits !== false) options.push({ value: 'edit', label: 'Change an answer' });
  return options;
}

/**
 * The choice Enter takes: the first, unless a step changes the whole machine or rewrites commits
 * (`fix`, `reauthor`), which, like its own question, needs a deliberate yes.
 */
export function reviewDefault(review: Review): ReviewOption['value'] {
  const deliberate = review.steps.some((step) => needsDeliberateYes(step.command));
  return !review.settled && deliberate ? 'decline' : reviewOptions(review)[0]!.value;
}
