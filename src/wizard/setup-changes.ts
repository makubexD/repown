// What one setup run changed. The diff is pure. The read is this clone's local
// config and the guard, through the Git wrapper. A credential helper is never
// run: it can print a live password, and this report shows config values only.

import type { Git } from '../core/git.ts';
import { ACCOUNT_KEY, EMAIL_KEY, NAME_KEY, USE_CONFIG_ONLY_KEY } from '../core/identity.ts';
import { guardState, type GuardState } from '../core/guard/hook.ts';

const ALLOW_OWNER = 'repown.allowOwner';
const AUTO_UPSTREAM = 'push.autoSetupRemote';
const LEADING = [NAME_KEY, EMAIL_KEY, USE_CONFIG_ONLY_KEY, ACCOUNT_KEY];

export interface CloneSnapshot {
  /** Local values in report order. Null means the key was unset. */
  readonly values: readonly (readonly [string, string | null])[];
  /** Every local `repown.allowOwner` value, in the order git stores them. */
  readonly allowOwner: readonly string[];
  /** Local `push.autoSetupRemote`, or null when this clone does not set it. */
  readonly autoUpstream: string | null;
  readonly guard: GuardState;
}

export async function readCloneSnapshot(git: Git, watched: readonly string[]): Promise<CloneSnapshot> {
  const keys = [...LEADING, ...watched];
  const found = await Promise.all(keys.map((key) => git.getConfig(key, 'local')));
  const [allowOwner, autoUpstream, guard] = await Promise.all([
    git.getAllConfig(ALLOW_OWNER, 'local'),
    git.getConfig(AUTO_UPSTREAM, 'local'),
    guardState(git),
  ]);
  return {
    values: keys.map((key, index): readonly [string, string | null] => [key, found[index] ?? null]),
    allowOwner, autoUpstream, guard,
  };
}

/** Lines for keys whose local value changed. Empty when the clone matches. */
export function cloneChangeLines(before: CloneSnapshot, after: CloneSnapshot): string[] {
  const next = new Map(after.values);
  return [
    ...before.values.flatMap(([key, old]) => keep(valueChange(key, old, next.get(key) ?? null))),
    ...allowChange(before.allowOwner, after.allowOwner),
    ...keep(valueChange(AUTO_UPSTREAM, before.autoUpstream, after.autoUpstream)),
    ...keep(guardChange(before.guard, after.guard)),
  ];
}

/** Registry and gh are this machine, not this clone. Null means that one did not change. */
export function machineChangeLines(registryAdded: string | null, ghAccount: string | null): string[] {
  const registry = registryAdded === null ? null : "  this machine's account registry: added " + registryAdded;
  const gh = ghAccount === null ? null : "  gh: " + ghAccount + " is now gh's active account (every terminal)";
  return [...keep(registry), ...keep(gh)];
}

function keep(line: string | null): string[] {
  return line === null ? [] : [line];
}

function valueChange(key: string, before: string | null, after: string | null): string | null {
  if (before === after) return null;
  if (before === null) return '  ' + key + ': (added) ' + shown(after!);
  if (after === null) return '  ' + key + ': ' + shown(before) + ' -> (removed)';
  return '  ' + key + ': ' + shown(before) + ' -> ' + shown(after);
}

/** A URL (`scheme://` or scp-style `user@host:`) can hold a token: the report names it, never shows it. */
function shown(value: string): string {
  return /^[a-z][\w+.-]*:\/\//i.test(value) || /^[^\s@/]+@[^\s:/]+:/.test(value) ? '(a URL)' : value;
}

function guardChange(before: GuardState, after: GuardState): string | null {
  if (before === after) return null;
  return '  push guard: ' + before + ' -> ' + after;
}

function allowChange(before: readonly string[], after: readonly string[]): string[] {
  const added = missing(after, before);
  const removed = missing(before, after);
  return [
    ...keep(added.length === 0 ? null : '  ' + ALLOW_OWNER + ': (added) ' + added.join(', ')),
    ...keep(removed.length === 0 ? null : '  ' + ALLOW_OWNER + ': ' + removed.join(', ') + ' -> (removed)'),
  ];
}

/** Values in `source` that `other` does not already hold, extras included. */
function missing(source: readonly string[], other: readonly string[]): string[] {
  const left = [...other];
  return source.filter((value) => {
    const at = left.indexOf(value);
    if (at < 0) return true;
    left.splice(at, 1);
    return false;
  });
}
