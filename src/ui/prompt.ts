// Asking the user for a value, with a default they can accept by pressing enter.
//
// Refuses rather than hangs when there is no terminal. A hook, a CI job or a
// piped invocation has nobody to answer, and a prompt there is an unkillable
// wait that looks like a crash -- so the absence of a TTY is reported as what it
// is, with the flag that would have avoided the question.
//
// The prompt itself writes to STDERR, matching every other piece of output that
// is not the payload (WARN and FAIL go there too): stdout stays reserved for
// whatever a command actually produces, so `repown accounts add x | tee log` does
// not interleave a prompt into the log.

import { createInterface } from 'node:readline/promises';
import { ok, err, type Result } from '../core/result.ts';

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

export async function ask(label: string, suggestion?: string): Promise<Result<string>> {
  if (!interactive()) {
    return err('this needs an interactive terminal to ask for the ' + label);
  }
  const shown = suggestion ? label + ' [' + suggestion + ']' : label;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('  ' + shown.padEnd(30) + ' ')).trim();
    const value = answer.length > 0 ? answer : (suggestion ?? '');
    return value.length > 0 ? ok(value) : err('a value is required for ' + label);
  } finally {
    rl.close();
  }
}

/** y or n; an empty answer is `fallback` (No unless the caller says the step is recommended). */
export async function confirm(question: string, fallback = false): Promise<boolean> {
  if (!interactive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('  ' + question + (fallback ? ' [Y/n] ' : ' [y/N] '))).trim().toLowerCase();
    return answer === '' ? fallback : answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Waits for Enter; false when the user types q (or there is no terminal to wait in). */
export async function waitForEnter(message: string): Promise<boolean> {
  if (!interactive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question('  ' + message + ' ')).trim().toLowerCase() !== 'q';
  } finally {
    rl.close();
  }
}
