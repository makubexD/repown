// The single choke point for every subprocess this tool runs.
//
// TWO INVARIANTS, BOTH LOAD-BEARING.
//
// 1. NOTHING HERE WRITES TO A CONSOLE, EVER. `git credential fill` returns a
//    live password on stdout. It is read in one place, which extracts the
//    username and discards the rest, and that is only safe while this layer
//    cannot leak. There is no debug flag and no logging hook by design -- the
//    absence is the control. test/exec.test.ts asserts it.
//
// 2. A NON-ZERO EXIT IS NOT AN ERROR. git answers questions with exit codes:
//    `git config --get missing.key` exits 1, and that is the answer "not set",
//    not a failure. So this resolves rather than rejects, and callers read
//    `code` themselves. (PowerShell 7.4 turning native exit codes into
//    terminating errors is what forced `Use-NativeExitCodes` in the version
//    this replaces; Node has no such behaviour, but the discipline is the same.)
//
// `shell: false` throughout: no argument ever reaches a shell parser, so a
// branch name or URL containing shell metacharacters cannot be interpreted.

import { spawn } from 'node:child_process';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not be launched at all (ENOENT and friends). */
  readonly spawnError?: NodeJS.ErrnoException;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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

    // Our own timer, NOT spawn's `timeout` option. Node clears that one only on
    // 'exit', which a spawn that fails (ENOENT) never emits -- so every probe for
    // a binary that is not on PATH held the process open for the full 30 s after
    // the command had already printed its answer.
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, spawnError: error });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    child.stdin.on('error', () => { /* the child may exit before stdin drains */ });
    child.stdin.end(options.input ?? '');
  });
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
