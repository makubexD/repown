// What actually supplies a credential on this machine.
//
// This is the answer to "why am I being asked for a password". That failure
// otherwise looks identical to a bad token:
//
//     remote: Invalid username or token. Password authentication is not supported
//     fatal: Authentication failed for 'https://github.com/...'
//
// which appears when the GitHub CLI is the credential helper and its active
// account is not the one the repository asked for. gh serves only its active
// account and returns nothing for any other, so the fix is not a new token -- it
// is to stop gh being the helper.
//
// Under that diagnosis, one row per account the registry, GCM or gh knows.
// accountRows decides the cells. A failed lookup stays `unknown`.

import { inspectRepo, inspectAuth, activeAccountLabel, type AuthState, type RepoState } from '../core/inspect.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import { gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

const DOCTOR_TITLE = 'repown doctor · how this machine signs in to git hosts';
const NAME_WIDTH = 14;
const NOT_YET = 'not signed in yet (the first push signs in)';
const HOST_SIGN_IN = 'your host\'s own sign-in';
const NONE_YET = 'none recorded, stored or signed in yet';
const NO_GCM = 'no accounts recorded or signed in to gh; Git Credential Manager isn\'t installed';
const STORED_UNUSED = 'stored in Git Credential Manager, which git isn\'t using';
const SETUP_POINTER = 'repown setup';

export default {
  summary: 'what serves credentials on this machine, and to whom',
  examples: ['repown doctor'],

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    const auth = await inspectAuth(git, repo.originUrl ?? undefined);
    printReport(repo, auth, await loadRegistry());
    return diagnose(auth, repo.provider.label);
  },
} satisfies Command;

export type DoctorAuth = Pick<AuthState, 'gcmPresent' | 'stored' | 'ghPresent' | 'gh' | 'helperIsGcm'>;

/** `recorded` is in the registry; `absent` was looked up and is not; `unknown` was not looked up. */
export type RecordedState = 'recorded' | 'absent' | 'unknown';

export interface AccountRow {
  readonly name: string;
  readonly thisClone: boolean;
  readonly recorded: RecordedState;
  readonly git: string;
  /** Null when the cell does not apply: gh is not installed, or the host is not GitHub. */
  readonly gh: string | null;
}

export interface SourceWarning {
  readonly tag: string;
  readonly message: string;
  readonly detail: string | null;
}

export interface AccountReport {
  readonly rows: readonly AccountRow[];
  /** Every source was read and named nobody. A failed read is never this. */
  readonly none: boolean;
  /** No rows, GCM is not installed, and the registry and gh were read and named nobody. */
  readonly gcmMissing: boolean;
  readonly warnings: readonly SourceWarning[];
}

interface Named {
  readonly name: string;
  readonly entry?: Account;
  readonly recorded: RecordedState;
}

export function accountRows(registry: Result<Registry>, auth: DoctorAuth, pinned: string | null): AccountReport {
  const rows = mergeNames(registry, auth).map((item) => toRow(item, auth, pinned));
  return reportOf(rows, registry, auth);
}

function reportOf(rows: AccountRow[], registry: Result<Registry>, auth: DoctorAuth): AccountReport {
  return {
    rows,
    none: rows.length === 0 && sourcesEmpty(registry, auth),
    gcmMissing: noGcmEmpty(rows, registry, auth),
    warnings: sourceWarnings(registry, auth),
  };
}

/** No rows, GCM is absent, and the registry and gh were read and named nobody. */
function noGcmEmpty(rows: readonly AccountRow[], registry: Result<Registry>, auth: DoctorAuth): boolean {
  if (rows.length > 0 || auth.gcmPresent) return false;
  if (!registry.ok || Object.keys(registry.value.accounts).length > 0) return false;
  if (!auth.ghPresent) return true;
  return auth.gh.ok && auth.gh.value.accounts.length === 0;
}

function mergeNames(registry: Result<Registry>, auth: DoctorAuth): Named[] {
  const recorded = registry.ok ? recordedNames(registry.value) : [];
  const mark: RecordedState = registry.ok ? 'absent' : 'unknown';
  return [...recorded, ...extraNames(recorded, auth, mark)];
}

function recordedNames(registry: Registry): Named[] {
  return Object.entries(registry.accounts).map(([name, entry]) => ({
    name, entry, recorded: 'recorded' as const,
  }));
}

function extraNames(recorded: readonly Named[], auth: DoctorAuth, mark: RecordedState): Named[] {
  const seen = new Set(recorded.map((item) => keyOf(item.name)));
  const extras = [...storeNames(auth), ...ghNames(auth)].filter((name) => keep(seen, name));
  extras.sort(byName);
  return extras.map((name) => ({ name, recorded: mark }));
}

function keep(seen: Set<string>, name: string): boolean {
  const key = keyOf(name);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function storeNames(auth: DoctorAuth): readonly string[] {
  return auth.stored.ok ? auth.stored.value : [];
}

function ghNames(auth: DoctorAuth): string[] {
  if (!auth.gh.ok) return [];
  return auth.gh.value.accounts.map((account) => account.login);
}

function byName(left: string, right: string): number {
  const [a, b] = [keyOf(left), keyOf(right)];
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function toRow(item: Named, auth: DoctorAuth, pinned: string | null): AccountRow {
  return {
    name: item.name,
    thisClone: pinned !== null && same(pinned, item.name),
    recorded: item.recorded,
    git: gitCell(item, auth),
    gh: ghCell(item, auth),
  };
}

/**
 * `stored` only when GCM is the helper and holds the account. Held under
 * another helper is named, not called `stored`. "The first push signs in"
 * is GCM's promise, so only then. A missing account is otherwise `unknown`,
 * including a store that could not be read: a failed read must not look
 * like "not signed in".
 */
function gitCell(item: Named, auth: DoctorAuth): string {
  if (item.entry && !githubHost(item.entry)) return HOST_SIGN_IN;
  if (!auth.gcmPresent || !auth.stored.ok) return 'unknown';
  if (listed(auth.stored.value, item.name)) return storedHow(auth);
  return auth.helperIsGcm ? NOT_YET : 'unknown';
}

function storedHow(auth: DoctorAuth): string {
  return auth.helperIsGcm ? 'stored' : STORED_UNUSED;
}

/**
 * `not installed` is stated once, on the machine line (`gh active`). A row
 * that repeated it would hide the git cell. Non-GitHub accounts have no gh
 * cell either: gh does not sign those hosts in (ADR-009).
 */
function ghCell(item: Named, auth: DoctorAuth): string | null {
  if ((item.entry && !githubHost(item.entry)) || !auth.ghPresent) return null;
  if (!auth.gh.ok) return 'unknown';
  return ghReadiness(item.name, auth);
}

function ghReadiness(name: string, auth: DoctorAuth): string {
  if (!auth.gh.ok) return 'unknown';
  const login = auth.gh.value.accounts.find((account) => same(account.login, name));
  if (!login) return 'not signed in';
  const active = auth.gh.value.active;
  return active !== null && same(active, name) ? 'active' : 'signed in';
}

function githubHost(entry: Account): boolean {
  return (entry.host ?? 'github') === 'github';
}

function sourcesEmpty(registry: Result<Registry>, auth: DoctorAuth): boolean {
  if (!registry.ok || Object.keys(registry.value.accounts).length > 0) return false;
  if (!auth.gcmPresent || !auth.stored.ok || auth.stored.value.length > 0) return false;
  if (!auth.ghPresent) return true;
  return auth.gh.ok && auth.gh.value.accounts.length === 0;
}

function sourceWarnings(registry: Result<Registry>, auth: DoctorAuth): SourceWarning[] {
  return [registryWarning(registry), storeWarning(auth), ghQueryWarning(auth)].filter(isWarning);
}

function isWarning(warning: SourceWarning | null): warning is SourceWarning {
  return warning !== null;
}

/** Same shape as status's registryUnread. Outside a clone there is no clone account to compare. */
function registryWarning(registry: Result<Registry>): SourceWarning | null {
  if (registry.ok) return null;
  return {
    tag: 'account',
    message: 'the account registry could not be read, so recorded accounts are unknown.',
    detail: 'see: repown accounts list',
  };
}

/** Not installed is the machine line `GCM  not found`. A warning is a read that failed. */
function storeWarning(auth: DoctorAuth): SourceWarning | null {
  if (!auth.gcmPresent || auth.stored.ok) return null;
  return { tag: 'store', message: 'stored accounts could not be read: ' + auth.stored.error, detail: null };
}

function ghQueryWarning(auth: DoctorAuth): SourceWarning | null {
  if (!auth.ghPresent || auth.gh.ok) return null;
  return {
    tag: 'gh',
    message: 'could not be queried (' + auth.gh.error + '), so signed-in accounts are unknown.',
    detail: 'check it yourself: gh auth status',
  };
}

function same(left: string, right: string): boolean {
  return keyOf(left) === keyOf(right);
}

function keyOf(name: string): string {
  return name.toLowerCase();
}

function listed(names: readonly string[], name: string): boolean {
  return names.some((candidate) => same(candidate, name));
}

export function formatAccountLines(report: AccountReport): string[] {
  if (report.rows.length === 0) return emptyLines(report);
  const width = Math.max(NAME_WIDTH, ...report.rows.map((row) => row.name.length + 1));
  return report.rows.map((row) => formatRow(row, width));
}

function emptyLines(report: AccountReport): string[] {
  if (report.none) return pointed(NONE_YET);
  if (report.gcmMissing) return pointed(NO_GCM);
  return [];
}

function pointed(line: string): string[] {
  return ['  ' + line, '  ' + SETUP_POINTER];
}

/** Names share one column, widened for the longest so no row runs into the next cell. */
function formatRow(row: AccountRow, width: number): string {
  return '  ' + row.name.padEnd(width) + ' ' + rowRest(row);
}

function rowRest(row: AccountRow): string {
  const body = rowBody(row);
  return row.thisClone ? '(this clone)  ' + body : body;
}

function rowBody(row: AccountRow): string {
  const parts = [recordedPhrase(row), 'git: ' + row.git];
  if (row.gh) parts.push('gh: ' + row.gh);
  return parts.filter((part) => part !== '').join(' · ');
}

function recordedPhrase(row: AccountRow): string {
  if (row.recorded === 'absent') return 'not recorded by repown';
  if (row.recorded === 'unknown') return 'recorded: unknown';
  return '';
}

function printReport(repo: RepoState, auth: AuthState, registry: Result<Registry>): void {
  out.heading(DOCTOR_TITLE);
  printMachine(auth);
  printAccounts(accountRows(registry, auth, pinnedOf(repo)));
  out.line();
}

function printMachine(auth: AuthState): void {
  out.heading('This machine');
  out.field('helper', auth.helper ?? 'none configured');
  out.field('GCM', auth.gcmPath ?? 'not found');
  out.field('gh active', activeAccountLabel(auth));
}

/** repown.account, else the credential username. No marker outside a clone. */
function pinnedOf(repo: RepoState): string | null {
  if (!repo.isRepo) return null;
  return repo.identity.owner ?? repo.identity.account;
}

function printAccounts(report: AccountReport): void {
  out.heading('Accounts');
  for (const line of formatAccountLines(report)) out.line(line);
  for (const warning of report.warnings) warnSource(warning);
}

function warnSource(warning: SourceWarning): void {
  out.warn(warning.tag, warning.message);
  if (warning.detail) out.detail(warning.detail);
}

function diagnose(auth: AuthState, providerLabel: string): number {
  if (auth.ghIsHelper) return diagnoseGhHelper(auth);
  if (!auth.helperIsGcm) return diagnoseUnknownHelper(auth);
  return diagnoseHealthy(auth, providerLabel);
}

function diagnoseGhHelper(auth: AuthState): number {
  out.fail('helper', 'gh is the credential helper for github.com.');
  out.detail('It serves ONLY its active account and returns nothing for any');
  out.detail('other, so every repository pinned to a different account is');
  out.detail('prompted for a password -- and `gh auth switch` moves the problem');
  out.detail('rather than fixing it.');

  // On its own line, and only when known: interpolating it inline printed an
  // empty "()" whenever gh could not be queried, which reads as a bug.
  if (auth.gh.ok && auth.gh.value.active) out.detail('Active right now: ' + auth.gh.value.active);

  const files = [...new Set(auth.ghHelperOrigins.map((entry) => entry.file))];
  if (files.length > 0) {
    out.detail('');
    out.detail('Installed by `gh auth setup-git`, in:');
    for (const file of files) out.detail('  ' + file);
  }
  out.line();
  out.line('  fix: repown fix');
  out.line();
  return 1;
}

function diagnoseUnknownHelper(auth: AuthState): number {
  out.warn('helper', 'github.com is served by "' + (auth.helper ?? 'nothing') +
                     '", which repown has no opinion about.');
  out.detail('The per-repository pin (credential.<url>.username) only works if');
  out.detail('that helper honours it.');
  out.line();
  return 0;
}

function diagnoseHealthy(auth: AuthState, providerLabel: string): number {
  out.line('  Credentials come from Git Credential Manager, which stores one per');
  out.line('  account and picks per repository from credential.<url>.username. No');
  out.line('  switching is needed for git, and `gh auth switch` affects the CLI only.');
  out.line();
  if (auth.stored.ok && auth.stored.value.length === 0) {
    out.warn('store', 'no accounts stored yet -- the first push will sign in once.');
    out.line();
  }
  ssoNote(providerLabel);
  return 0;
}

// Not a check -- repown cannot see this coming (ADR-013, "Deliberately
// not done"). A credential that is otherwise healthy still fails the moment
// it touches an org it is not SSO-authorized for, and that failure looks
// identical to a bad token. Printed unconditionally so it is there before it
// is needed. The exact fix command is gh-specific, so it only names `gh` for
// a GitHub origin -- gh does not manage auth for any other host.
function ssoNote(providerLabel: string): void {
  out.line('  If a push or fetch still fails right after this, the credential may');
  out.line('  be valid but not yet SSO-authorized for that organisation. Re-authorize it:');
  out.line(providerLabel === 'GitHub'
    ? '  gh auth refresh -h <host>, or via the org\'s SSO settings.'
    : "  check your git host's SSO / conditional-access settings.");
  out.line();
}
