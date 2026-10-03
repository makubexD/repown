// What the repown setup test files share: scripted prompters, a Home sandbox with a
// recorded account, the CLI runner and small readers. Moved out of wizard-setup.test.ts
// unchanged when it was split by suite so node --test can run the parts in parallel.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { setupContext as context } from './setup-fixtures.ts';
import { ok, err } from '../src/core/result.ts';
import { wizard, BACK, CANCEL, type Answers, type Prompter, type Reply, type Review, type ReviewChoice, type StepConfirm } from '../src/wizard/engine.ts';
import { setupFlow, planCommands, formatCommand, gitStepOf, keptFlags, blockersOf, changesOf, briefOf, missingFlags, printable, NEW_ACCOUNT, DETECTED_PREFIX, accountOf, isNew, signedInLogins, type SetupContext, type Suggestion } from '../src/wizard/setup-flow.ts';
import { pinWrites } from '../src/core/identity.ts';
import { plainPrompter } from '../src/wizard/plain.ts';
import { reviewLines, reviewDefault } from '../src/wizard/review-text.ts';
import { gitSupportsAutoUpstream } from '../src/core/version.ts';
import { SETUP_NOTE } from '../src/commands/start.ts';
import { runSetup } from '../src/wizard/setup-run.ts';
import { cloneChangeLines, machineChangeLines, readCloneSnapshot, type CloneSnapshot } from '../src/wizard/setup-changes.ts';
import { readContext } from '../src/wizard/setup-context.ts';
import { Git } from '../src/core/git.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { inherit, handingOver } from '../src/core/exec.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
plainTerminal();

// ---------------------------------------------------------------- the flow
export type Entry = readonly [string, Reply | ReviewChoice];

export function scripted(script: Entry[]): Prompter & { readonly asked: string[]; readonly reviews: Review[]; readonly confirms: StepConfirm[] } {
  const queue = [...script];
  const next = (id: string): Reply | ReviewChoice => {
    const entry = queue.shift();
    assert.ok(entry, 'script ran out at ' + id);
    assert.equal(entry[0], id, 'the wizard asked ' + id + ', the script expected ' + entry[0]);
    return entry[1];
  };
  const asked: string[] = [];
  const reviews: Review[] = [];
  const confirms: StepConfirm[] = [];
  return {
    asked,
    reviews,
    confirms,
    ask: async (step) => { asked.push(step.id); return next(step.id) as Reply; },
    review: async (review) => { reviews.push(review); return next('review') as ReviewChoice; },
    pickStep: async () => next('pick') as string,
    choose: async () => { throw new Error('setup does not choose'); },
    note: () => {},
    close: () => {},
    confirmStep: async (brief) => {
      confirms.push(brief);
      const choice = next('step');
      return choice === CANCEL ? CANCEL : choice as 'yes' | 'skip' | 'stop';
    },
  };
}

/** Step by step, so a script is asked every question. Pass `mode` in `given` to drive Recommended. */
export async function answer(ctx: SetupContext, script: Entry[], given: Answers = {}): Promise<Answers> {
  const mode = given['mode'] === undefined ? { mode: 'step' } : {};
  const outcome = await wizard(setupFlow(ctx), ctx, { ...mode, ...given }, scripted(script));
  assert.equal(outcome.status, 'run');
  return outcome.status === 'run' ? outcome.answers : {};
}

/** Every line of text a review shows. */
export const textOf = (review: Review): string[] =>
  [review.title, ...review.headline, ...review.notes, ...review.steps.flatMap((step) => [step.what, step.command, ...step.detail])];

export const argvOf = (answers: Answers, ctx: SetupContext): (readonly string[])[] =>
  planCommands(answers, ctx).map((command) => command.argv);

/** Newest first, as git log lists them; the oldest commit's parent is `rebaseBase`. */
export function onBranch(emails: readonly string[], rebaseBase = 'abc1234'): SetupContext['unpushed'] {
  const parentOf = (index: number): string | null =>
    index < emails.length - 1 ? 'fff' + index : rebaseBase === '--root' ? null : rebaseBase;
  return {
    branch: 'main',
    commits: ok(emails.map((address, index) => ({ authorEmail: address, committerEmail: address, parent: parentOf(index) }))),
    unknown: null,
  };
}

export function reviewNotes(ctx: SetupContext, answers: Answers = { account: 'octocat' }): string {
  return setupFlow(ctx).review(answers, ctx).notes.join('\n');
}

/** A commit-tree whose committer date is fixed, so log order does not depend on the clock. */
export function commitAt(box: Sandbox, date: string, args: readonly string[]): string {
  const saved = { author: process.env['GIT_AUTHOR_DATE'], committer: process.env['GIT_COMMITTER_DATE'] };
  process.env['GIT_AUTHOR_DATE'] = date;
  process.env['GIT_COMMITTER_DATE'] = date;
  try {
    return box.git(...args);
  } finally {
    restoreEnv('GIT_AUTHOR_DATE', saved.author);
    restoreEnv('GIT_COMMITTER_DATE', saved.committer);
  }
}

export function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export async function plainChoice(keys: string, initial: 'yes' | 'skip'): Promise<{ choice: unknown; shown: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = plainPrompter({ input, output });
  if (keys) input.write(keys);
  else input.end();
  const choice = await prompter.confirmStep({
    changes: ['user.name = Octo Cat'],
    why: 'Pin this clone to octocat: its commit name, email and push sign-in',
    command: 'repown use octocat',
    initial,
  });
  prompter.close();
  return { choice, shown };
}

export function stepOf(ctx: SetupContext, id: string) {
  const found = setupFlow(ctx).steps.find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

export function wording(text: string | ((answers: Answers, ctx: SetupContext) => string), answers: Answers, ctx: SetupContext): string {
  return typeof text === 'function' ? text(answers, ctx) : text;
}

/** A POSIX shell's word splitting, for the quoted words formatCommand produces. */
export function shellSplit(line: string): string[] {
  return [...line.matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"|(\S+)/g)].map((match) =>
    match[1] !== undefined ? match[1].replaceAll("'\\''", "'") : match[2] ?? match[3]!);
}

// ---------------------------------------------------------------- the command
export interface Home {
  readonly box: Sandbox;
  readonly registry: string;
  readonly dispose: () => void;
}

export function home(): Home {
  const box = sandbox();
  const registry = mkdtempSync(join(tmpdir(), 'repown-registry-'));
  const saved = process.env['REPOWN_CONFIG_DIR'];
  process.env['REPOWN_CONFIG_DIR'] = registry;
  // By the account most tests pin, so the clone has no commit by another address unless a test makes one.
  box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  return { box, registry, dispose: () => {
    if (saved === undefined) delete process.env['REPOWN_CONFIG_DIR']; else process.env['REPOWN_CONFIG_DIR'] = saved;
    rmSync(registry, { recursive: true, force: true });
    box.dispose();
  } };
}

export function record(at: Home, account: string, email: string): void {
  writeFileSync(join(at.registry, 'accounts.json'), JSON.stringify({ accounts: { [account]: { name: 'Octo Cat', email, host: 'github' } } }));
}

export function repown(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, input: '', env: process.env, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

export const localConfig = (at: Home): string => readFileSync(join(at.box.dir, '.git', 'config'), 'utf8');

export const hook = (at: Home): string => join(at.box.dir, '.git', 'hooks', 'pre-push');

export function shot(
  values: readonly (readonly [string, string | null])[],
  allowOwner: readonly string[],
  autoUpstream: string | null,
  guard: 'off' | 'on' | 'foreign',
): CloneSnapshot {
  return { values, allowOwner, autoUpstream, guard };
}

export function sectionLines(stderr: string, start: string, end: string): string[] {
  const lines = stderr.split('\n');
  const from = lines.findIndex((line) => line.includes(start));
  assert.ok(from >= 0, start + '\n' + stderr);
  const rest = lines.slice(from + 1);
  const until = rest.findIndex((line) => line.includes(end));
  return (until < 0 ? rest : rest.slice(0, until)).map((line) => line.trim()).filter((line) => line.length > 0);
}

export function expectedPin(box: Sandbox): string[] {
  const upstream = gitSupportsAutoUpstream(box.git('--version')) ? ['push.autoSetupRemote: (added) true'] : [];
  return [
    'user.name: Sandbox -> Octo Cat',
    'user.email: sandbox@example.invalid -> octocat@example.invalid',
    'user.useConfigOnly: (added) true',
    'repown.account: (added) octocat',
    'credential.https://github.com.username: (added) octocat',
    ...upstream,
    'push guard: off -> on',
  ];
}

export function ghAuth(active: string, logins: readonly string[]): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: ok({ accounts: logins.map((login) => ({ login, active: login === active })), active }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

export const WAIT_CHILD = 'const fs=require("fs");fs.writeFileSync(process.argv[1],"up");' +
  'const stop=process.argv[1]+".stop";' +
  'const wait=()=>{if(fs.existsSync(stop))process.exit(0);else setTimeout(wait,15)};wait()';

export async function plainLead(box: Sandbox): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk: Buffer) => { shown += chunk.toString(); });
  const prompter = plainPrompter({ input, output });
  input.end();
  const code = await runSetup(
    { positional: [], flags: new Map([['cwd', box.dir]]) },
    { interactive: true, prompter, lead: SETUP_NOTE },
  );
  assert.equal(code, 130, shown);
  return shown;
}

export function guarded(at: Home): { positional: readonly string[]; flags: Map<string, string | boolean> } {
  const flags = new Map<string, string | boolean>([['cwd', at.box.dir], ['guard', true], ['no-input', true]]);
  return { positional: ['octocat'], flags };
}

export async function holdInherit(): Promise<() => Promise<void>> {
  const marker = join(tmpdir(), 'repown-hold-' + process.pid);
  const stop = marker + '.stop';
  rmSync(marker, { force: true });
  rmSync(stop, { force: true });
  const pending = inherit(process.execPath, ['-e', WAIT_CHILD, marker]);
  const release = (): Promise<void> => releaseInherit(pending, marker, stop);
  try {
    await untilUp(marker);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

export async function untilUp(marker: string): Promise<void> {
  const started = Date.now();
  while (!existsSync(marker)) {
    if (Date.now() - started > 5_000) throw new Error('child did not start');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.equal(handingOver(), true);
}

export async function releaseInherit(pending: Promise<unknown>, marker: string, stop: string): Promise<void> {
  writeFileSync(stop, 'x');
  await pending;
  rmSync(marker, { force: true });
  rmSync(stop, { force: true });
}

export function captureStep(onFirst: () => void): { text: () => string; begin: () => void; end: () => void } {
  let stderr = '';
  let emitted = false;
  const write = process.stderr.write;
  const begin = (): void => {
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const text = String(chunk);
      stderr += text;
      if (!emitted && text.includes('step 1 of')) { emitted = true; onFirst(); }
      return true;
    }) as typeof process.stderr.write;
  };
  return { text: () => stderr, begin, end: () => { process.stderr.write = write; } };
}
