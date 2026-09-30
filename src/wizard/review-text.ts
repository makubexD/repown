// The words around a review, shared by both prompters so the plain and the drawn
// screens say the same thing: the numbered steps, the closing lines, the question, its
// choices and which one Enter takes, and "Change an answer". What goes IN the review
// comes from the flow (setup-flow.ts).

import type { Review, ReviewChoice, StepChoice } from './engine.ts';

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

/** What a step changes, why, and the command, in that order. */
export function stepConfirmLines(brief: { readonly changes: readonly string[]; readonly why: string; readonly command: string }): string[] {
  return [...brief.changes, '', brief.why, '> ' + brief.command];
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
 * command line (dimmed where the prompter can draw colour), so the plain words stay
 * the eye's first stop.
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
 * One line, wrapped at spaces to `width`. Continuation lines line up under the text:
 * past any indent, a "1. " step number, or a "label   " column.
 */
export function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const hang = ' '.repeat(/^\s*(?:\d+\. |\S+(?: \S+)? {2,})?/.exec(text)![0].length);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/(?<=\S) (?=\S)/)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = hang + word.trimStart(); }
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

/** Done, then a way to pick another account or sign in to gh. Change an answer stays once questions were asked. */
function settledOptions(review: Review): ReviewOption[] {
  const options: ReviewOption[] = [
    { value: 'done', label: 'Done', hint: 'change nothing' },
    { value: 'account', label: 'Use another account', hint: 'choose a different account for this clone' },
  ];
  if (review.ghSignIn) options.push({ value: 'gh', label: review.ghSignIn });
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
