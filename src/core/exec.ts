// The single choke point for every subprocess this tool runs.
//
// TWO INVARIANTS, BOTH LOAD-BEARING.
//
// 1. THIS FILE WRITES NOTHING. `run` returns whatever the child prints and
//    never shows it. Credential helpers and git can print live secrets, and
//    there is no debug flag and no logging hook by design -- the absence is
//    the control. test/exec.test.ts asserts it.
//
//    `inherit` hands the terminal to the child (`stdio: 'inherit'`). repown
//    never sees that output -- the result's stdout and stderr stay empty --
//    so a credential cannot pass through repown. It is used only for
//    `gh auth login`, and only from a terminal. The child prints to the
//    terminal itself; this function still writes nothing.
//    The parent ignores SIGINT while the child runs, so Ctrl-C reaches the child.
//
// 2. A NON-ZERO EXIT IS NOT AN ERROR. git answers questions with exit codes:
//    `git config --get missing.key` exits 1, and that is the answer "not set",
//    not a failure. So both runners resolve rather than reject, and callers
//    read `code` themselves. A spawn error such as ENOENT resolves too, as
//    `notInstalled`. (PowerShell 7.4 turning native exit codes into
//    terminating errors is what forced `Use-NativeExitCodes` in the version
//    this replaces; Node has no such behaviour, but the discipline is the same.)
//
// `shell: false` throughout: no argument ever reaches a shell parser, so a
// branch name or URL containing shell metacharacters cannot be interpreted.

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not be launched at all (ENOENT and friends). */
  readonly spawnError?: NodeJS.ErrnoException;
  /** Killed at the timeout -- so a caller can say "timed out", not just "failed". */
  readonly timedOut?: boolean;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** `inherit` takes an environment and nothing else: the child has the terminal. */
export interface InheritOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export type InheritFn = (
  file: string,
  args: readonly string[],
  options?: InheritOptions,
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** How many `inherit` children are running. `handingOver` is the read-only view. */
let inherited = 0;

/** True while an inherited child is running. Ctrl-C then belongs to that child. */
export function handingOver(): boolean {
  return inherited > 0;
}

/**
 * The timeout is our own timer, NOT spawn's `timeout` option. Node clears that
 * one only on 'exit', which a spawn that fails (ENOENT) never emits -- so every
 * probe for a binary that is not on PATH held the process open for the full
 * 30 s after the command had already printed its answer.
 */
export function run(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });
    const output = collect(child);
    const clock: Clock = { timedOut: false, timers: [] };
    const settle = once((result: Omit<ExecResult, 'stdout' | 'stderr'>): void => {
      for (const timer of clock.timers) clearTimeout(timer);
      resolve({ ...output(), ...result, ...(clock.timedOut ? { timedOut: true } : {}) });
    });
    clock.timers.push(setTimeout(() => expire(child, clock, settle), options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    child.on('error', (error: NodeJS.ErrnoException) => settle({ code: -1, spawnError: error }));
    child.on('close', (code) => settle({ code: code ?? -1 }));

    child.stdin.on('error', () => { /* the child may exit before stdin drains */ });
    child.stdin.end(options.input ?? '');
  });
}

interface Clock {
  timedOut: boolean;
  readonly timers: NodeJS.Timeout[];
}

/** How long a stopped child's pipes may stay open before repown stops waiting for them. */
const GRACE_MS = 3_000;

/**
 * At the timeout: stop the child and what it started, then stop waiting after a grace even
 * if a process it started still holds the pipes ('close' waits for every holder).
 */
function expire(child: ChildProcessWithoutNullStreams, clock: Clock, settle: (result: Omit<ExecResult, 'stdout' | 'stderr'>) => void): void {
  clock.timedOut = true;
  stopTree(child);
  clock.timers.push(setTimeout(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    settle({ code: child.exitCode ?? -1 });
  }, GRACE_MS));
}

/**
 * SIGTERM to the child on POSIX. On Windows the git on PATH is often a wrapper (cmd\git.exe)
 * whose real git outlives TerminateProcess, so the whole tree is ended with taskkill /T /F
 * while the child still runs (Node holds its handle, so the PID is still ours); the child
 * itself is killed after, so the tree is still there to walk. A forced end runs no cleanup:
 * a lock git held stays, as the timeout message's callers say.
 */
function stopTree(child: ChildProcessWithoutNullStreams): void {
  const running = child.exitCode === null && child.signalCode === null;
  if (process.platform !== 'win32' || child.pid === undefined || !running) { child.kill(); return; }
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows';
  const killer = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
    shell: false, windowsHide: true, stdio: 'ignore',
  });
  const after = once(() => { child.kill(); });
  killer.on('error', after);
  killer.on('close', after);
}

/** A function that runs only the first time it is called. */
function once<T extends unknown[]>(act: (...args: T) => void): (...args: T) => void {
  let done = false;
  return (...args: T) => {
    if (done) return;
    done = true;
    act(...args);
  };
}

/**
 * The terminal belongs to the child. Only `gh auth login` uses this, and only
 * from a terminal: repown cannot see what the child prints.
 */
export function inherit(
  file: string,
  args: readonly string[],
  options: InheritOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    inherited += 1;
    const ignore = (): void => {};
    process.on('SIGINT', ignore);
    const child = spawn(file, [...args], {
      env: options.env ?? process.env,
      shell: false,
      stdio: 'inherit',
      // gh must stay attached to the console so it receives Ctrl-C.
      windowsHide: false,
    });
    settleInherit(child, ignore, resolve);
  });
}

/** Drops the parent's SIGINT listener when the child closes or fails to spawn. */
function settleInherit(child: ChildProcess, ignore: () => void, resolve: (result: ExecResult) => void): void {
  let settled = false;
  const done = (result: ExecResult): void => {
    if (settled) return;
    settled = true;
    inherited -= 1;
    process.off('SIGINT', ignore);
    resolve(result);
  };
  child.on('error', (error: NodeJS.ErrnoException) => done(spawnFailure(error)));
  child.on('close', (code) => done({ code: code ?? -1, stdout: '', stderr: '' }));
}

function spawnFailure(error: NodeJS.ErrnoException): ExecResult {
  return { code: -1, stdout: '', stderr: '', spawnError: error };
}

/** Accumulates the child's stdout and stderr; call the result for what has arrived so far. */
function collect(child: ChildProcessWithoutNullStreams): () => { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  return () => ({ stdout, stderr });
}

/** Ran, and exited 0. */
export function succeeded(result: ExecResult): boolean {
  return result.code === 0 && result.spawnError === undefined;
}

/** The binary itself is missing -- distinct from it running and refusing. */
export function notInstalled(result: ExecResult): boolean {
  return result.spawnError?.code === 'ENOENT';
}

/** stdout with trailing newlines removed, or null when the command did not succeed. */
export function output(result: ExecResult): string | null {
  if (!succeeded(result)) return null;
  const text = result.stdout.replace(/\r?\n$/, '');
  return text.length > 0 ? text : null;
}

/** stdout split into non-empty trimmed lines. Empty when the command failed. */
export function lines(result: ExecResult): string[] {
  if (!succeeded(result)) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
