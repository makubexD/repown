// The GitHub CLI, asked only about ITSELF.
//
// After `repown fix` gh has nothing to do with git authentication. It remains the
// account store and the thing `gh pr create` acts as, and that is worth
// reporting -- a pull request opened from the wrong account on a public repo is
// as permanent as a commit.
//
// `ghLogin` does not ask. It hands the terminal to `gh auth login` and never
// reads what gh prints. Below gh 2.40.0 that login is refused: it would
// replace the host's account.
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

import { run, inherit, succeeded, notInstalled, type ExecResult, type InheritFn } from '../exec.ts';
import { ok, err, type Result } from '../result.ts';
import { versionAtLeast } from '../version.ts';

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
  return ghStateFrom(await run('gh', ['auth', 'status', '--json', 'hosts']), host);
}

/** A finished `gh auth status --json hosts`. Exit 0 with no host entry is nobody signed in. */
export function ghStateFrom(result: ExecResult, host = 'github.com'): Result<GhState> {
  if (notInstalled(result)) return err('gh is not installed');
  if (!succeeded(result)) return err('gh auth status failed');
  const parsed = parseHosts(result.stdout, host);
  if (!parsed) return err('gh auth status returned nothing usable');
  return ok(parsed);
}

/**
 * gh 2.88.1 exits 0 and prints `{"hosts":{}}` when it is signed in to nobody.
 * A missing host key, or an empty list, is that same answer.
 */
function parseHosts(raw: string, host: string): GhState | null {
  const hosts = hostsObject(raw);
  if (hosts === null) return null;
  if (!Object.hasOwn(hosts, host)) return { accounts: [], active: null };
  const entries = hosts[host];
  if (!Array.isArray(entries)) return null;
  return accountsFrom(entries);
}

function hostsObject(raw: string): Record<string, unknown> | null {
  const parsed = jsonObject(raw);
  if (parsed === null) return null;
  const hosts = parsed['hosts'];
  return isRecord(hosts) ? hosts : null;
}

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(plainJson(raw)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** gh paints `--json` when colour is forced, even on a pipe. The object is unchanged. */
function plainJson(raw: string): string {
  return raw.replace(/\x1b\[[0-9;]*m/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function accountsFrom(entries: readonly unknown[]): GhState {
  const accounts = entries.flatMap(toAccount);
  const active = accounts.find((account) => account.active)?.login ?? null;
  return { accounts, active };
}

function toAccount(raw: unknown): GhAccount[] {
  const entry = raw as { login?: unknown; active?: unknown };
  if (typeof entry?.login !== 'string' || !entry.login) return [];
  return [{ login: entry.login, active: entry.active === true }];
}

/** Arguments for a github.com profile, every field at once. `--hostname` so GH_HOST cannot redirect the call. */
export function ghUserArgs(login: string): readonly string[] {
  // One path segment, whatever the login holds (callers also look up only GitHub-shaped logins).
  return ['api', '--hostname', 'github.com', `users/${encodeURIComponent(login)}`];
}

/** github.com's profile for a login (null when unknown), and whether it said there is no such account. */
export interface UserLookup {
  readonly fields: Readonly<Record<string, unknown>> | null;
  readonly missing: boolean;
}

/** A profile field's value, and whether github.com said there is no such account. */
export interface ProfileLookup {
  readonly value: string | null;
  readonly missing: boolean;
}

export async function ghUser(login: string): Promise<UserLookup> {
  return userLookupFrom(await run('gh', ghUserArgs(login)));
}

/** Only github.com's own 404 means missing: offline, refused, no gh or an unreadable reply is unknown. */
export function userLookupFrom(result: ExecResult): UserLookup {
  const missing = !succeeded(result) && /\(HTTP 404\)/.test(result.stderr);
  return { fields: succeeded(result) ? objectIn(result.stdout) : null, missing };
}

/** One field as text: a non-empty string as it is, a number in decimal, anything else null. */
export function fieldOf(user: UserLookup, field: string): ProfileLookup {
  const value = user.fields?.[field];
  const text = typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
  return { value: text, missing: user.missing };
}

/** The JSON object gh printed, or null: a reply that is not one is an unknown, like a failed call. */
function objectIn(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function ghSwitch(login: string): Promise<Result<void>> {
  const result = await run('gh', ['auth', 'switch', '-u', login]);
  if (notInstalled(result)) return err('gh is not installed');
  if (!succeeded(result)) return err(result.stderr.trim() || `gh auth switch exited ${result.code}`);
  return ok(undefined);
}

/**
 * gh before 2.40.0 replaces the host's one account on `auth login`. `unknown`
 * means the text was not a version, and login must not run in that case either.
 */
export type GhLoginVersion = 'ready' | 'old' | 'unknown';

const LOGIN_MIN: readonly [number, number, number] = [2, 40, 0];

export function ghLoginVersion(text: string): GhLoginVersion {
  const found = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!found) return 'unknown';
  return versionAtLeast(found, LOGIN_MIN) ? 'ready' : 'old';
}

export async function readGhLoginVersion(): Promise<GhLoginVersion> {
  const result = await run('gh', ['--version']);
  return succeeded(result) ? ghLoginVersion(result.stdout) : 'unknown';
}

export type GhLoginError =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Browser login for one host. The child inherits the terminal (`inherit`), with
 * `GH_TOKEN` and `GITHUB_TOKEN` removed so gh will store the new sign-in.
 */
export async function ghLogin(host: string, runner: InheritFn = inherit): Promise<Result<void, GhLoginError>> {
  const result = await runner('gh', loginArgs(host), { env: withoutGhTokens(process.env) });
  return loginResult(result);
}

function loginArgs(host: string): string[] {
  return ['auth', 'login', '--hostname', host, '--web', '--git-protocol', 'https'];
}

function loginResult(result: ExecResult): Result<void, GhLoginError> {
  if (notInstalled(result)) return err({ kind: 'failed', reason: 'gh is not installed' });
  if (result.spawnError) return err({ kind: 'failed', reason: result.spawnError.message });
  if (result.code === 0) return ok(undefined);
  if (result.code === 2) return err({ kind: 'cancelled' });
  return err({ kind: 'failed', reason: 'gh auth login exited ' + result.code });
}

/** Windows matches env names case-insensitively; either spelling blocks login. */
function withoutGhTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isGhToken(key)) continue;
    child[key] = value;
  }
  return child;
}

function isGhToken(key: string): boolean {
  const name = key.toUpperCase();
  return name === 'GH_TOKEN' || name === 'GITHUB_TOKEN';
}
