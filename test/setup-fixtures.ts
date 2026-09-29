// Fixtures for `repown setup` tests: a hand-built SetupContext (what readContext would
// read from a clone and a machine), and `play`, which drives the real @clack/prompts
// screens with key presses -- arrows, Enter, typed text, Esc -- through in-memory
// streams, and returns what was drawn. Nothing touches a terminal or a repository.

import { PassThrough } from 'node:stream';
import { ok } from '../src/core/result.ts';
import { wizard, type Answers, type Outcome, type Prompter } from '../src/wizard/engine.ts';
import { briefOf, planCommands, setupFlow, type SetupContext } from '../src/wizard/setup-flow.ts';
import { clackPrompter } from '../src/wizard/clack.ts';

export const KEY = { enter: '\r', up: '\x1b[A', down: '\x1b[B', esc: '\x1b', backspace: '\x7f' } as const;

/** Typed text, one key press per character. */
export const typed = (text: string): string[] => [...text];

export function setupContext(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    ...baseline(),
    recorded: { octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' } },
    addresses: ok(new Map()),
    suggest: async () => ({}),
    ...overrides,
  };
}

function baseline(): Omit<SetupContext, 'recorded' | 'addresses' | 'suggest'> {
  return {
    cwd: null,
    pinned: null,
    pinIntact: false,
    host: 'github',
    owner: 'octocat',
    detected: [],
    ownerIsUser: null,
    allowed: [],
    credentialPinned: true,
    credentialKeys: ['credential.https://github.com.username'],
    hookPath: null,
    gh: null,
    ghIsHelper: false,
    guard: 'off',
    redirected: false,
    fixLines: null,
    machineIdentity: { name: null, email: null },
    // No branch: these screens are not the unpushed-commit note. A test that
    // wants the note passes the commits readUnpushed would have read.
    unpushed: { branch: null, commits: ok([]), unknown: null },
    // Nothing else in the way of the next push, unless a test says so.
    push: {
      env: [], configOverrides: [], elsewhere: ok([]), signinKey: null, destination: null,
      divergence: ok(null), detached: false, upstream: null,
    },
    // Already on, so these screens are not the upstream question. A test for that
    // question passes enabled: null. An otherwise settled clone where it is still
    // offered counts as settled and names `repown setup --auto-upstream`.
    upstream: { supported: true, enabled: true, branch: 'main', tracked: null },
    stored: null,
  };
}

export interface Played {
  readonly outcome: Outcome | { readonly status: 'stuck' };
  /** Everything drawn, colour and cursor codes removed: every frame, in order. */
  readonly screen: string;
}

/** The same player as `play`, for a screen that is not the setup wizard. */
export interface PlayedRun {
  readonly result: unknown;
  /** Everything drawn, colour and cursor codes removed: every frame, in order. */
  readonly screen: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PlayOptions {
  readonly given?: Answers;
  /** How long to wait before calling the wizard stuck: generous, since a loaded CI runner draws slowly. */
  readonly patience?: number;
  /** The window's width; unset, like a stream that isn't a terminal. */
  readonly columns?: number;
}

/**
 * Plays the wizard: each group of keys is pressed once the screen has settled after
 * the previous one. A wizard still waiting after the last group ends as 'stuck'.
 * Pass a function instead of a context to drive some other screen with the same keys.
 */
export async function play(ctx: SetupContext, keys: readonly (readonly string[])[], options?: PlayOptions): Promise<Played>;
export async function play(run: (prompter: Prompter) => Promise<unknown>, keys: readonly (readonly string[])[], options?: PlayOptions): Promise<PlayedRun>;
export async function play(
  ctx: SetupContext | ((prompter: Prompter) => Promise<unknown>),
  keys: readonly (readonly string[])[],
  options: PlayOptions = {},
): Promise<Played | PlayedRun> {
  if (typeof ctx === 'function') return playScreen(ctx, keys, options);
  const { given = {}, patience = 10_000, columns } = options;
  const stage = openStage(keys, columns);
  const stuck = new Promise<{ status: 'stuck' }>((resolve) => { setTimeout(() => resolve({ status: 'stuck' }), patience).unref(); });
  const outcome = await Promise.race([played(ctx, given, stage.prompter), stuck]);
  stage.stop();
  return { outcome, screen: stage.screen() };
}

async function playScreen(run: (prompter: Prompter) => Promise<unknown>, keys: readonly (readonly string[])[], options: PlayOptions): Promise<PlayedRun> {
  const { patience = 10_000, columns } = options;
  const stage = openStage(keys, columns);
  const stuck = new Promise<unknown>((resolve) => { setTimeout(() => resolve({ status: 'stuck' }), patience).unref(); });
  const captured = await captureWrites(() => Promise.race([run(stage.prompter), stuck]));
  stage.stop();
  return { ...captured, screen: stage.screen() };
}

interface Stage {
  readonly prompter: Prompter;
  screen(): string;
  stop(): void;
}

function openStage(keys: readonly (readonly string[])[], columns: number | undefined): Stage {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), columns ? { columns } : {});
  const queue = [...keys];
  let drawn = '';
  let idle: NodeJS.Timeout | undefined;
  const pressNext = (): void => { for (const key of queue.shift() ?? []) input.write(key); };
  output.on('data', (chunk: Buffer) => { drawn += chunk.toString(); clearTimeout(idle); idle = setTimeout(pressNext, 40); });
  return {
    prompter: clackPrompter({ input, output }),
    screen: () => drawn.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    stop: () => clearTimeout(idle),
  };
}

async function captureWrites<T>(run: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  // Keep the original write: the test runner reports on these streams too.
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return writeOut.call(process.stdout, chunk); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return writeErr.call(process.stderr, chunk); }) as typeof process.stderr.write;
  try {
    return { result: await run(), stdout, stderr };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

async function played(ctx: SetupContext, given: Answers, prompter: Prompter): Promise<Outcome> {
  const outcome = await wizard(setupFlow(ctx), ctx, given, prompter);
  if (outcome.status === 'run') await replaySteps(outcome.answers, ctx, prompter);
  return outcome;
}

/** The same confirmation the run shows. Skip continues; Stop or Esc ends the screens. */
async function replaySteps(answers: Answers, ctx: SetupContext, prompter: Prompter): Promise<void> {
  if (answers['mode'] !== 'step') return;
  for (const planned of planCommands(answers, ctx)) {
    const choice = await prompter.confirmStep(briefOf(planned, answers, ctx));
    if (choice !== 'yes' && choice !== 'skip') return;
  }
}

/** The lines of the screen that contain `text`. */
export const linesWith = (screen: string, text: string): string[] => screen.split('\n').filter((line) => line.includes(text));
