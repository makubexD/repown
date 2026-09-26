// Fixtures for `repown setup` tests: a hand-built SetupContext (what readContext would
// read from a clone and a machine), and `play`, which drives the real @clack/prompts
// screens with key presses -- arrows, Enter, typed text, Esc -- through in-memory
// streams, and returns what was drawn. Nothing touches a terminal or a repository.

import { PassThrough } from 'node:stream';
import { ok } from '../src/core/result.ts';
import { wizard, type Answers, type Outcome } from '../src/wizard/engine.ts';
import { setupFlow, type SetupContext } from '../src/wizard/setup-flow.ts';
import { clackPrompter } from '../src/wizard/clack.ts';

export const KEY = { enter: '\r', up: '\x1b[A', down: '\x1b[B', esc: '\x1b', backspace: '\x7f' } as const;

/** Typed text, one key press per character. */
export const typed = (text: string): string[] => [...text];

export function setupContext(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    cwd: null,
    recorded: { octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' } },
    pinned: null,
    pinIntact: false,
    host: 'github',
    owner: 'octocat',
    allowed: [],
    credentialPinned: true,
    gh: null,
    ghIsHelper: false,
    guard: 'off',
    redirected: false,
    fixLines: null,
    addresses: ok(new Map()),
    suggest: async () => ({}),
    ...overrides,
  };
}

export interface Played {
  readonly outcome: Outcome | { readonly status: 'stuck' };
  /** Everything drawn, colour and cursor codes removed: every frame, in order. */
  readonly screen: string;
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
 */
export async function play(ctx: SetupContext, keys: readonly (readonly string[])[], options: PlayOptions = {}): Promise<Played> {
  const { given = {}, patience = 10_000, columns } = options;
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), columns ? { columns } : {});
  const queue = [...keys];
  let screen = '';
  let idle: NodeJS.Timeout | undefined;
  const pressNext = (): void => { for (const key of queue.shift() ?? []) input.write(key); };
  output.on('data', (chunk: Buffer) => { screen += chunk.toString(); clearTimeout(idle); idle = setTimeout(pressNext, 40); });
  const stuck = new Promise<{ status: 'stuck' }>((resolve) => { setTimeout(() => resolve({ status: 'stuck' }), patience).unref(); });
  const outcome = await Promise.race([wizard(setupFlow(ctx), ctx, given, clackPrompter({ input, output })), stuck]);
  clearTimeout(idle);
  return { outcome, screen: screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
}

/** The lines of the screen that contain `text`. */
export const linesWith = (screen: string, text: string): string[] => screen.split('\n').filter((line) => line.includes(text));
