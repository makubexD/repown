// The wizard's navigation: which step comes next, going back, skipping what was
// given as a flag, and the review loop. It draws nothing itself -- a Prompter does
// (src/wizard/plain.ts, src/wizard/clack.ts, or a scripted one in the tests) -- and
// it writes nothing: it only returns the answers the review accepted. What those
// answers turn into is the flow's job (src/wizard/setup-flow.ts).
//
// WHY THE ENGINE OWNS "BACK". No prompt library draws navigation across questions
// (@clack/prompts has none), so the history lives here, where the scripted tests
// can drive it without a terminal.

export const BACK = Symbol('back');
export const CANCEL = Symbol('cancel');

export type Answer = string | boolean;
export type Answers = Record<string, Answer>;
export type Reply = Answer | typeof BACK | typeof CANCEL;
export type ReviewChoice = 'run' | 'back' | 'edit' | 'decline' | 'done' | typeof CANCEL;

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface Step<C> {
  readonly id: string;
  readonly kind: 'text' | 'select' | 'confirm';
  readonly message: string;
  readonly hint: string;
  /** The option or positional this answer becomes, shown in help and in errors. */
  readonly flag: string;
  choices?(answers: Answers, context: C): Choice[];
  /** The default; may be looked up (a profile suggestion), so it may be a promise. */
  initial?(answers: Answers, context: C): Answer | undefined | Promise<Answer | undefined>;
  /** A line of context shown with the question, worked out from earlier answers. */
  detail?(answers: Answers, context: C): string | undefined;
  /** The same rule the command applies; a message when the value is refused. */
  validate?(value: Answer): string | null;
  /** Asked only when this holds; absent means always. */
  when?(answers: Answers, context: C): boolean;
}

/** One command the review will run: what it does in plain words, and the command itself. */
export interface ReviewStep {
  readonly what: string;
  readonly command: string;
  /** Lines shown under the command, such as what it removes. */
  readonly detail: readonly string[];
}

export interface Review {
  readonly title: string;
  /** What the answers add up to, before the steps. */
  readonly headline: readonly string[];
  readonly steps: readonly ReviewStep[];
  /** Warnings and side notes, after the steps. */
  readonly notes: readonly string[];
  /** Nothing needs to change: offer Done first, and running the steps again second. */
  readonly settled: boolean;
}

/** What a prompter needs to ask one step. */
export interface Asked {
  readonly initial: Answer | undefined;
  readonly choices: readonly Choice[];
  /** A line of context shown with the question. */
  readonly detail: string | undefined;
  /** False for the first question asked: there is nothing to go back to. */
  readonly canGoBack: boolean;
}

export interface Flow<C> {
  readonly steps: readonly Step<C>[];
  review(answers: Answers, context: C): Review;
}

export interface Prompter {
  ask(step: Step<never>, asked: Asked): Promise<Reply>;
  review(review: Review): Promise<ReviewChoice>;
  /** "Change an answer": one of the steps that were asked, or BACK to the review. */
  pickStep(steps: readonly Step<never>[]): Promise<string | typeof BACK | typeof CANCEL>;
  note(message: string): void;
  /** Releases the terminal once the questions are over; safe to call more than once. */
  close(): void;
  /** Optional framing: a title, a closing line, and a line while the state is read. */
  intro?(title: string): void;
  outro?(message: string): void;
  busy?(message: string): void;
}

export type Outcome =
  | { readonly status: 'run'; readonly answers: Answers }
  | { readonly status: 'declined' }
  | { readonly status: 'done' }
  | { readonly status: 'cancelled' };

interface Pass {
  readonly answers: Answers;
  readonly start: number;
  readonly given: ReadonlySet<string>;
  /** Steps already asked before `start`, so Back can keep going past it. */
  readonly history: readonly number[];
}

type Walk = { readonly status: 'answered'; readonly answers: Answers; readonly asked: number[] } | { readonly status: 'cancelled' };

/** Asks every reachable step from `pass.start` on, with a history for going back. */
export async function runFlow<C>(flow: Flow<C>, context: C, pass: Pass, prompter: Prompter): Promise<Walk> {
  const answers = { ...pass.answers };
  const asked = [...pass.history];
  let index = pass.start;
  while (index < flow.steps.length) {
    const step = flow.steps[index]!;
    if (!askable(step, answers, context, pass.given)) { index++; continue; }
    const reply = await ask(step, { answers, canGoBack: asked.length > 0 }, context, prompter);
    if (reply === CANCEL) return { status: 'cancelled' };
    if (reply === BACK) { index = asked.pop() ?? index; continue; }
    const problem = step.validate?.(reply) ?? null;
    if (problem) { prompter.note(problem); continue; }
    answers[step.id] = reply;
    asked.push(index++);
  }
  return { status: 'answered', answers: prune(flow, answers, context, pass.given), asked };
}

async function ask<C>(step: Step<C>, at: { answers: Answers; canGoBack: boolean }, context: C, prompter: Prompter): Promise<Reply> {
  const { answers, canGoBack } = at;
  const initial = answers[step.id] ?? await step.initial?.(answers, context);
  const choices = step.choices?.(answers, context) ?? [];
  return prompter.ask(step as Step<never>, { initial, choices, detail: step.detail?.(answers, context), canGoBack });
}

function askable<C>(step: Step<C>, answers: Answers, context: C, given: ReadonlySet<string>): boolean {
  return !given.has(step.id) && (step.when?.(answers, context) ?? true);
}

/** Drops answers whose step is no longer reachable, so a stale branch never reaches the plan. */
export function prune<C>(flow: Flow<C>, answers: Answers, context: C, given: ReadonlySet<string>): Answers {
  const kept: Answers = {};
  for (const step of flow.steps) {
    const value = answers[step.id];
    if (value === undefined) continue;
    if (given.has(step.id) || (step.when?.(kept, context) ?? true)) kept[step.id] = value;
  }
  return kept;
}

/** A value given as a flag passes the same check a typed answer would: one message per refusal. */
export function refusedGiven<C>(flow: Flow<C>, given: Answers): string[] {
  return flow.steps.flatMap((step) => {
    const value = given[step.id];
    const problem = value === undefined ? null : step.validate?.(value) ?? null;
    return problem ? [step.flag + ': ' + problem] : [];
  });
}

/** Steps the user can return to from the review: reachable, and not given as a flag. */
export function reachable<C>(flow: Flow<C>, answers: Answers, context: C, given: ReadonlySet<string>): Step<C>[] {
  return flow.steps.filter((step) => answers[step.id] !== undefined && askable(step, answers, context, given));
}

/** The whole wizard: ask, review, and loop back on Back or Change an answer. */
export async function wizard<C>(flow: Flow<C>, context: C, given: Answers, prompter: Prompter): Promise<Outcome> {
  const fixed = new Set(Object.keys(given));
  let pass: Pass = { answers: { ...given }, start: 0, given: fixed, history: [] };
  for (;;) {
    const walk = await runFlow(flow, context, pass, prompter);
    if (walk.status === 'cancelled') return walk;
    const review = flow.review(walk.answers, context);
    const choice = await prompter.review(review);
    if (choice === 'run') return { status: 'run', answers: walk.answers };
    // Done promises "nothing needed changing": on a review with work left, it changes nothing either way.
    if (choice === 'done') return { status: review.settled ? 'done' : 'declined' };
    if (choice === 'decline' || choice === CANCEL) return { status: choice === CANCEL ? 'cancelled' : 'declined' };
    const start = await restartAt(flow, context, { walk, given: fixed, choice }, prompter);
    if (start === CANCEL) return { status: 'cancelled' };
    pass = { answers: walk.answers, start, given: fixed, history: walk.asked.filter((index) => index < start) };
  }
}

interface Return {
  readonly walk: { readonly answers: Answers; readonly asked: readonly number[] };
  readonly given: ReadonlySet<string>;
  readonly choice: 'back' | 'edit';
}

/**
 * Where to resume: the last step asked (Back), or the one the user picks (Change an
 * answer). With nothing asked -- every value given as a flag -- Back has nowhere to go
 * and simply shows the review again.
 */
async function restartAt<C>(flow: Flow<C>, context: C, how: Return, prompter: Prompter): Promise<number | typeof CANCEL> {
  if (how.choice === 'back') return how.walk.asked.at(-1) ?? flow.steps.length;
  const steps = reachable(flow, how.walk.answers, context, how.given);
  if (steps.length === 0) { prompter.note('every answer came from a flag: there is nothing here to change'); return flow.steps.length; }
  const id = await prompter.pickStep(steps as Step<never>[]);
  if (id === CANCEL) return CANCEL;
  if (id === BACK) return flow.steps.length;
  const index = flow.steps.findIndex((step) => step.id === id);
  return index < 0 ? flow.steps.length : index;
}
