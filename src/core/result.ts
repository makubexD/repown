// A recoverable outcome. Used wherever a failure is an ANSWER rather than a bug:
// "gh could not be queried", "this host has no provider", "GCM is not installed".
//
// The distinction that matters, and that the PowerShell version had to learn the
// hard way: a check that was SKIPPED must never look like one that PASSED. An
// `ok: false` carries a reason and callers are forced to handle it, where a bare
// `null` let a failed lookup silently disappear into a falsy branch.

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
