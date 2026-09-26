// The words around a review, shared by both prompters so the plain and the drawn
// screens say the same thing: the numbered steps, the closing line, the question and
// its choices. What goes IN the review comes from the flow (setup-flow.ts).

import type { Review, ReviewChoice } from './engine.ts';

export interface ReviewOption {
  readonly value: Exclude<ReviewChoice, symbol>;
  readonly label: string;
  readonly hint?: string;
}

/**
 * The body of the review, line by line. `command` styles each command line (dimmed
 * where the prompter can draw colour), so the plain words stay the eye's first stop.
 */
export function reviewLines(review: Review, command: (text: string) => string = (text) => text): string[] {
  if (review.settled) return [...review.headline, '', 'Nothing needs to change.', ...notesOf(review)];
  const steps = review.steps.flatMap((step, index) => [
    (index + 1) + '. ' + step.what,
    command('     ' + step.command),
    ...step.detail.map((line) => command('     ' + line)),
  ]);
  return [...review.headline, '', 'When you choose Run:', ...steps, ...notesOf(review), '',
    'These are ordinary repown commands: run them yourself, or in a script.',
    'A clone\'s settings go in its .git/config, which is never pushed.'];
}

function notesOf(review: Review): string[] {
  return review.notes.length > 0 ? ['', ...review.notes] : [];
}

export function reviewQuestion(review: Review): string {
  if (review.settled) return 'What now?';
  return review.steps.length === 1 ? 'Run this step?' : 'Run these ' + review.steps.length + ' steps?';
}

export function reviewOptions(review: Review): ReviewOption[] {
  if (review.settled) {
    return [
      { value: 'done', label: 'Done', hint: 'change nothing' },
      { value: 'run', label: 'Apply the same settings again' },
      { value: 'edit', label: 'Change an answer' },
    ];
  }
  return [
    { value: 'run', label: review.steps.length === 1 ? 'Run it' : 'Run them' },
    { value: 'back', label: 'Back', hint: 'to the last question' },
    { value: 'edit', label: 'Change an answer' },
    { value: 'decline', label: 'Decline', hint: 'change nothing and exit' },
  ];
}

/** The last choice of "Which answer do you want to change?". */
export const BACK_TO_REVIEW = '← Back to the review';
