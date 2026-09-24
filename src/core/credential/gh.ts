// The GitHub CLI, asked only about ITSELF.
//
// After `repown fix` gh has nothing to do with git authentication. It remains the
// account store and the thing `gh pr create` acts as, and that is worth
// reporting -- a pull request opened from the wrong account on a public repo is
// as permanent as a commit.
//
// NOT `gh api user`. That spent an API round trip to learn one login and, the
// reason it had to go, returned nothing on failure. Callers guarded their
// warnings on the value being truthy, so an offline machine or an expired token
// made those warnings SILENTLY VANISH and the output looked clean rather than
// uncertain. `gh auth status --json hosts` reports every account and the active
// one in a single local call, and exits 0 even when one account has a token
// problem -- so one bad account no longer erases the whole picture.
//
// "Could not be queried" is a THIRD STATE, distinct both from "gh is not
// installed" and from "gh is active as nobody". Collapsing it into either is the
// bug this shape exists to prevent.

import { run, succeeded, notInstalled, output } from '../exec.ts';
import { ok, err, type Result } from '../result.ts';

export interface GhAccount {
  readonly login: string;
  readonly active: boolean;
}

export interface GhState {
  readonly accounts: readonly GhAccount[];
  readonly active: string | null;
}

/**
 * A credential-helper value that `gh auth setup-git` wrote -- `!gh auth
 * git-credential`, or with gh's path, quoted on Windows -- and nothing more. A
 * composite (`... | manager`) or another CLI's helper (`glab auth git-credential`)
 * is not gh's, and `repown fix` must not remove it.
 */
export function isGh(helper: string | null): boolean {
  return helper !== null && /^!(?:.*[\\/'\s])?gh(?:\.exe)?'?\s+auth\s+git-credential\s*$/.test(helper.trim());
}

export async function ghInstalled(): Promise<boolean> {
  return !notInstalled(await run('gh', ['--version']));
}

export async function ghState(host = 'github.com'): Promise<Result<GhState>> {
  const result = await run('gh', ['auth', 'status', '--json', 'hosts']);
  if (notInstalled(result)) return err('gh is not installed');
  if (!succeeded(result)) return err('gh auth status failed');

  const parsed = parseHosts(result.stdout, host);
  if (!parsed) return err('gh auth status returned nothing usable');
  return ok(parsed);
}

function parseHosts(raw: string, host: string): GhState | null {
  let hosts: Record<string, unknown>;
  try {
    hosts = (JSON.parse(raw) as { hosts?: Record<string, unknown> }).hosts ?? {};
  } catch {
    return null;
  }
  const entries = hosts[host];
  if (!Array.isArray(entries)) return null;

  const accounts = entries.flatMap(toAccount);
  const active = accounts.find((account) => account.active)?.login ?? null;
  return { accounts, active };
}

function toAccount(raw: unknown): GhAccount[] {
  const entry = raw as { login?: unknown; active?: unknown };
  if (typeof entry?.login !== 'string' || !entry.login) return [];
  return [{ login: entry.login, active: entry.active === true }];
}

/** A profile field from the public API, or null. Absence here is unremarkable. */
export async function ghProfileField(login: string, field: string): Promise<string | null> {
  const result = await run('gh', ['api', `users/${login}`, '--jq', `.${field}`]);
  const value = output(result);
  return value && value !== 'null' ? value : null;
}

export async function ghSwitch(login: string): Promise<Result<void>> {
  const result = await run('gh', ['auth', 'switch', '-u', login]);
  if (notInstalled(result)) return err('gh is not installed');
  if (!succeeded(result)) return err(result.stderr.trim() || `gh auth switch exited ${result.code}`);
  return ok(undefined);
}
