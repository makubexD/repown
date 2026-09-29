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
export type ReviewChoice = 'run' | 'back' | 'edit' | 'decline' | 'done' | 'account' | 'gh' | typeof CANCEL;
export type StepChoice = 'yes' | 'skip' | 'stop';

/** What one planned step would change, shown before it runs in step-by-step mode. */
export interface StepConfirm {
  readonly changes: readonly string[];
  /** One sentence: the step's own words. */
  readonly why: string;
  readonly command: string;
  /** The choice Enter takes. */
  readonly initial: 'yes' | 'skip';
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/** Question text, or a function of the answers when the words depend on them. */
export type Wording<C> = string | ((answers: Answers, context: C) => string);

export interface Step<C> {
  readonly id: string;
  readonly kind: 'text' | 'select' | 'confirm';
  readonly message: Wording<C>;
  readonly hint: Wording<C>;
  /** The option or positional this answer becomes, shown in help and in errors. */
  readonly flag: string;
  choices?(answers: Answers, context: C): Choice[];
  /** The default; may be looked up (a profile suggestion), so it may be a promise. */
  initial?(answers: Answers, context: C): Answer | undefined | Promise<Answer | undefined>;
  /** A line of context shown with the question, worked out from earlier answers. */
  detail?(answers: Answers, context: C): string | undefined;
  /** The same rule the command applies; a message when the value is refused. */
  validate?(value: Answer): string | null;
  /** Asked only when this holds; absent means always. A false here drops the answer. */
  when?(answers: Answers, context: C): boolean;
  /** Skipped on the way through. Change an answer can still open it, and that ask is once. */
  auto?(answers: Answers, context: C): boolean;
  /** Not asked on the way through, and not filled in. An answer already given still stands. */
  skip?(answers: Answers, context: C): boolean;
}

/** A step whose question has already been chosen for the answers so far. */
export interface Drawn {
  readonly id: string;
  readonly kind: 'text' | 'select' | 'confirm';
  readonly message: string;
  readonly hint: string;
  readonly flag: string;
  validate?(value: Answer): string | null;
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
  /** Nothing needs to change. Done exits; an empty plan is not offered as a re-run. */
  readonly settled: boolean;
  /** Settled screen only: sign this account in to gh, when gh acts as someone else. */
  readonly ghSignIn?: string;
  /** False when nothing has been asked, so Change an answer is not offered. */
  readonly edits?: boolean;
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
  /** Answers for steps the walk did not ask. Applied before prune, so the review can list them. */
  fill?(answers: Answers, context: C): Answers;
  /** Shown before the first question when nothing was given as a flag. Null starts the questions. */
  opening?(context: C): Review | null;
  /** Where an opening choice continues: its answers, and the step index to ask from. */
  resume?(choice: 'account' | 'gh', context: C): { readonly answers: Answers; readonly start: number };
}

export interface Prompter {
  ask(step: Drawn, asked: Asked): Promise<Reply>;
  review(review: Review): Promise<ReviewChoice>;
  /** "Change an answer": one of the steps that were asked, or BACK to the review. */
  pickStep(steps: readonly Drawn[]): Promise<string | typeof BACK | typeof CANCEL>;
  /** One of `options`, or CANCEL on Esc or Ctrl-C. */
  choose(message: string, options: readonly Choice[]): Promise<string | typeof CANCEL>;
  note(message: string): void;
  /** Lines of information drawn in the prompter's frame. */
  show?(lines: readonly string[]): void;
  /** Step by step, before one command. Cancel means Stop. */
  confirmStep(confirm: StepConfirm): Promise<StepChoice | typeof CANCEL>;
  /** Hand the terminal to the command that follows a confirmation. */
  suspend?(): void;
  /** Releases the terminal once the questions are over; safe to call more than once. */
  close(): void;
  /** Optional framing: a title, a closing line (`cancelled` after Esc or Ctrl-C), and a line while the state is read. */
  intro?(title: string): void;
  outro?(message: string, cancelled?: boolean): void;
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
  /** Back from the first question of this pass returns to the opening review. */
  readonly toOpening: boolean;
  /** Show the flow's opening review before asking. */
  readonly showOpening: boolean;
}

type Walk = { readonly status: 'answered'; readonly answers: Answers; readonly asked: number[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'opening' };

/** Asks every reachable step from `pass.start` on, with a history for going back. */
export async function runFlow<C>(flow: Flow<C>, context: C, pass: Pass, prompter: Prompter): Promise<Walk> {
  const answers = { ...pass.answers };
  const asked = [...pass.history];
  let index = pass.start;
  while (index < flow.steps.length) {
    const step = flow.steps[index]!;
    if (!shouldAsk(step, { answers, context, given: pass.given, resume: index === pass.start })) { index++; continue; }
    const reply = await ask(step, { answers, canGoBack: asked.length > 0 || pass.toOpening }, context, prompter);
    if (reply === CANCEL) return { status: 'cancelled' };
    if (reply === BACK) { const back = retreat(asked, pass.toOpening, index); if (back.walk) return back.walk; index = back.index; continue; }
    if (keep(step, reply, prompter, { answers, asked, index })) index++;
  }
  return { status: 'answered', answers: filled(flow, answers, context, pass.given), asked };
}

function retreat(asked: number[], toOpening: boolean, index: number): { readonly walk?: Walk; readonly index: number } {
  if (asked.length > 0) return { index: asked.pop()! };
  return toOpening ? { walk: { status: 'opening' }, index } : { index };
}

function keep<C>(step: Step<C>, reply: Answer, prompter: Prompter, bag: { answers: Answers; asked: number[]; index: number }): boolean {
  const problem = step.validate?.(reply) ?? null;
  if (problem) { prompter.note(problem); return false; }
  bag.answers[step.id] = reply;
  bag.asked.push(bag.index);
  return true;
}

/** The step this walk resumed on is asked even when `auto` would skip it. */
function shouldAsk<C>(step: Step<C>, at: { answers: Answers; context: C; given: ReadonlySet<string>; resume: boolean }): boolean {
  if (!applicable(step, at.answers, at.context, at.given)) return false;
  if (at.resume) return true;
  if (step.skip?.(at.answers, at.context)) return false;
  return !step.auto?.(at.answers, at.context);
}

function applicable<C>(step: Step<C>, answers: Answers, context: C, given: ReadonlySet<string>): boolean {
  return !given.has(step.id) && (step.when?.(answers, context) ?? true);
}

function filled<C>(flow: Flow<C>, answers: Answers, context: C, given: ReadonlySet<string>): Answers {
  return prune(flow, flow.fill?.(answers, context) ?? answers, context, given);
}

async function ask<C>(step: Step<C>, at: { answers: Answers; canGoBack: boolean }, context: C, prompter: Prompter): Promise<Reply> {
  const { answers, canGoBack } = at;
  const initial = answers[step.id] ?? await step.initial?.(answers, context);
  const choices = step.choices?.(answers, context) ?? [];
  const detail = step.detail?.(answers, context);
  return prompter.ask(drawn(step, answers, context), { initial, choices, detail, canGoBack });
}

function drawn<C>(step: Step<C>, answers: Answers, context: C): Drawn {
  const shown = {
    id: step.id, kind: step.kind, flag: step.flag,
    message: wording(step.message, answers, context), hint: wording(step.hint, answers, context),
  };
  return step.validate ? { ...shown, validate: step.validate } : shown;
}

function wording<C>(text: Wording<C>, answers: Answers, context: C): string {
  return typeof text === 'function' ? text(answers, context) : text;
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
  return flow.steps.filter((step) => answers[step.id] !== undefined && applicable(step, answers, context, given));
}

interface Next {
  readonly outcome: Outcome | null;
  readonly pass: Pass;
}

function fresh(given: Answers, fixed: ReadonlySet<string>): Pass {
  return { answers: { ...given }, start: 0, given: fixed, history: [], toOpening: false, showOpening: fixed.size === 0 };
}

/** The whole wizard: an opening review when the flow has one, then ask, review, and loop. */
export async function wizard<C>(flow: Flow<C>, context: C, given: Answers, prompter: Prompter): Promise<Outcome> {
  const fixed = new Set(Object.keys(given));
  let pass = fresh(given, fixed);
  for (;;) {
    const opened = await takeOpening(flow, context, pass, prompter);
    if (opened.outcome) return opened.outcome;
    pass = opened.pass;
    const walked = await takePass(flow, context, pass, prompter);
    if (walked.outcome) return walked.outcome;
    pass = walked.pass;
  }
}

async function takeOpening<C>(flow: Flow<C>, context: C, pass: Pass, prompter: Prompter): Promise<Next> {
  if (!pass.showOpening) return { outcome: null, pass };
  const opening = flow.opening?.(context) ?? null;
  if (!opening) return { outcome: null, pass: { ...pass, showOpening: false } };
  return openingChoice({ flow, context, pass, prompter }, await prompter.review(opening));
}

interface Scene<C> {
  readonly flow: Flow<C>;
  readonly context: C;
  readonly pass: Pass;
  readonly prompter: Prompter;
}

function openingChoice<C>(scene: Scene<C>, choice: ReviewChoice): Next {
  const stopped = stoppedChoice(choice);
  if (stopped) return { outcome: stopped, pass: scene.pass };
  if (choice === 'account' || choice === 'gh') return { outcome: null, pass: resumed(scene, choice, null) };
  if (choice === 'edit') scene.prompter.note('nothing has been asked yet');
  return { outcome: null, pass: scene.pass };
}

function stoppedChoice(choice: ReviewChoice): Outcome | null {
  if (choice === 'done') return { status: 'done' };
  if (choice === 'decline') return { status: 'declined' };
  if (choice === CANCEL) return { status: 'cancelled' };
  return null;
}

interface Walked {
  readonly answers: Answers;
  readonly asked: readonly number[];
}

function resumed<C>(scene: Scene<C>, choice: 'account' | 'gh', walk: Walked | null): Pass {
  const spot = scene.flow.resume?.(choice, scene.context);
  const start = spot?.start ?? 0;
  return {
    answers: branchAnswers(choice, spot?.answers ?? {}, walk), start, given: scene.pass.given,
    history: walk ? walk.asked.filter((index) => index < start) : [],
    toOpening: walk === null, showOpening: false,
  };
}

function branchAnswers(choice: 'account' | 'gh', freshAnswers: Answers, walk: Walked | null): Answers {
  if (!walk) return freshAnswers;
  return choice === 'gh' ? { ...walk.answers, gh: true } : walk.answers;
}

async function takePass<C>(flow: Flow<C>, context: C, pass: Pass, prompter: Prompter): Promise<Next> {
  const walk = await runFlow(flow, context, pass, prompter);
  if (walk.status === 'cancelled') return { outcome: { status: 'cancelled' }, pass };
  if (walk.status === 'opening') return { outcome: null, pass: fresh({}, pass.given) };
  return afterReview({ flow, context, pass, prompter }, walk);
}

async function afterReview<C>(scene: Scene<C>, walk: Walked): Promise<Next> {
  const shown = scene.flow.review(walk.answers, scene.context);
  const choice = await scene.prompter.review(shown);
  const direct = directChoice(choice, shown, walk.answers);
  if (direct) return { outcome: direct, pass: scene.pass };
  if (choice === 'account' || choice === 'gh') return { outcome: null, pass: resumed(scene, choice, walk) };
  return restart(scene, walk, choice);
}

/** Done promises "nothing needed changing": on a review with work left, it changes nothing either way. */
function directChoice(choice: ReviewChoice, shown: Review, answers: Answers): Outcome | null {
  if (choice === 'run') return { status: 'run', answers };
  if (choice === 'done') return { status: shown.settled ? 'done' : 'declined' };
  if (choice === 'decline') return { status: 'declined' };
  if (choice === CANCEL) return { status: 'cancelled' };
  return null;
}

async function restart<C>(scene: Scene<C>, walk: Walked, choice: ReviewChoice): Promise<Next> {
  if (choice !== 'back' && choice !== 'edit') return { outcome: null, pass: scene.pass };
  const how = { walk, given: scene.pass.given, choice, toOpening: scene.pass.toOpening };
  const start = await restartAt(scene.flow, scene.context, how, scene.prompter);
  if (start === CANCEL) return { outcome: { status: 'cancelled' }, pass: scene.pass };
  if (start === 'opening') return { outcome: null, pass: fresh({}, scene.pass.given) };
  return { outcome: null, pass: continued(scene.pass, walk, start) };
}

function continued(pass: Pass, walk: Walked, start: number): Pass {
  return {
    answers: walk.answers, start, given: pass.given,
    history: walk.asked.filter((index) => index < start),
    toOpening: false, showOpening: false,
  };
}

interface Return {
  readonly walk: Walked;
  readonly given: ReadonlySet<string>;
  readonly choice: 'back' | 'edit';
  readonly toOpening: boolean;
}

/**
 * Where to resume: the last step asked (Back), or the one the user picks (Change an
 * answer). With nothing asked -- every value given as a flag -- Back has nowhere to go
 * and simply shows the review again. Back from a pass that came from the opening
 * review returns there.
 */
async function restartAt<C>(flow: Flow<C>, context: C, how: Return, prompter: Prompter): Promise<number | typeof CANCEL | 'opening'> {
  if (how.choice === 'back') return backIndex(how, flow);
  const steps = reachable(flow, how.walk.answers, context, how.given).map((step) => drawn(step, how.walk.answers, context));
  if (steps.length === 0) { prompter.note('every answer came from a flag: there is nothing here to change'); return flow.steps.length; }
  const id = await prompter.pickStep(steps);
  if (id === CANCEL) return CANCEL;
  if (id === BACK) return flow.steps.length;
  const index = flow.steps.findIndex((step) => step.id === id);
  return index < 0 ? flow.steps.length : index;
}

function backIndex<C>(how: Return, flow: Flow<C>): number | 'opening' {
  const last = how.walk.asked.at(-1);
  if (last !== undefined) return last;
  return how.toOpening ? 'opening' : flow.steps.length;
}
