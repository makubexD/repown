// What `repown status` prints: is this clone set up correctly?
// Bare `repown` runs this when output isn't a terminal. In a terminal, a clone
// goes to setup whether or not it is pinned (commands/start.ts).
//
// Three separate things decide who you are here, and they fail differently:
//
//   user.name / user.email            who AUTHORED the commit
//   credential.<host>.username        which stored credential serves the push
//   the CLI's active account          who `gh pr create` acts as
//
// All three are printed, because the one that is invisible is the one that
// catches people out. gh's active account is a note: it never affects the push.
// A gh that could not be queried stays a warning, because that answer is unknown.
// What would stop the next push (blockers.ts, the list setup reads too) comes first among
// the warnings, and `ready:` is said only without it (ADR-026). It is still a warning:
// the exit code is unchanged (ADR-020). This reports; it changes nothing.

import { inspectRepo, inspectAuth, activeAccountLabel, type RepoState, type AuthState } from '../core/inspect.ts';
import { isPinned } from '../core/identity.ts';
import { loadRegistry, type Account, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import { allowedOwners, shellWord } from '../core/guard/check.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';
import { printable } from '../ui/format.ts';
import { blockers, type Blocker } from '../core/blockers.ts';
import { readPushFacts } from '../core/push-state.ts';
import { readUnpushed } from '../core/unpushed.ts';

export default {
  summary: 'this clone\'s and this machine\'s settings, and what to fix (bare `repown` when output isn\'t a terminal)',

  async run(args: Args): Promise<number> {
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) {
      out.fail('repown', 'Not a git repository: ' + git.cwd);
      out.detail('repown pins an identity per clone, so it needs one to work in.');
      return 1;
    }
    const auth = await inspectAuth(git, repo.originUrl ?? undefined);
    const registry = await loadRegistry();

    await summary(repo, auth, registry);
    const problems = collectProblems(repo, auth);
    const account = accountShown(repo, registry);
    const found = problems.length === 0 ? await pushBlockers(repo, account) : [];
    const warnings = await reportWarnings(repo, auth, registry, found);
    const code = verdict(repo, auth, problems);
    const ghNote = printGhNote(pinnedAccount(repo), auth);
    closeStatus({ repo, problems, warnings, blockers: found, account, ghNote });
    return code;
  },
} satisfies Command;

/** "Honours it" only where the helper is GCM, the one measured to read the pin (ADR-001). */
function verdict(repo: RepoState, auth: AuthState, problems: readonly Problem[]): number {
  if (problems.length === 0) {
    out.pass('identity', repo.credentialKeys.length > 0 && auth.helperIsGcm
      ? 'this clone is pinned, and its credential mechanism honours it'
      : 'this clone\'s commit identity is pinned; its credentials are left to ' + (repo.helper ?? 'nothing'));
    return 0;
  }
  out.line();
  for (const problem of problems) { out.fail('identity', problem.what); out.detail('fix: ' + problem.fix); }
  return 1;
}

const STATUS_TITLE = 'repown status · current settings of this clone';

async function summary(repo: RepoState, auth: AuthState, registry: LoadedRegistry): Promise<void> {
  out.heading(STATUS_TITLE);
  out.line(place(repo));
  await cloneSettings(repo, registry);
  machineSettings(repo, auth);
  out.line();
}

function place(repo: RepoState): string {
  const where = out.displayPath(repo.root ?? repo.git.cwd);
  return repo.branch ? '  ' + where + '  ' + headLabel(repo.branch) : '  ' + where;
}

function headLabel(branch: NonNullable<RepoState['branch']>): string {
  if (branch.kind === 'detached') return '(detached at ' + branch.hash + ')';
  return '(branch ' + branch.name + ')';
}

async function cloneSettings(repo: RepoState, registry: LoadedRegistry): Promise<void> {
  const id = repo.identity;
  out.heading('This clone');
  out.field('commits as', person(id.name, id.email, 'NOT SET LOCALLY'));
  out.field('pushes as', pushesAs(repo));
  out.field('account', accountOf(repo, registry));
  out.field('origin', originOf(repo));
  await writeUpstream(repo);
  out.field('push guard', repo.guard);
}

async function writeUpstream(repo: RepoState): Promise<void> {
  const value = await upstreamField(repo);
  if (value !== null) out.field('upstream', value);
}

/** Printed when `push.autoSetupRemote` is on and the branch tracks nothing yet. */
export const UPSTREAM_ON = 'set on the first push (push.autoSetupRemote)';

/** The tracked ref, else the auto-setup wording when that flag is on, else nothing. */
export function upstreamText(tracked: string | null, enabled: boolean | null): string | null {
  if (tracked !== null) return tracked;
  return enabled === true ? UPSTREAM_ON : null;
}

async function upstreamField(repo: RepoState): Promise<string | null> {
  const branch = repo.branch;
  if (branch?.kind !== 'branch') return null;
  const remotes = await repo.git.remotes();
  if (remotes.length === 0) return null;
  const tracked = await repo.git.upstreamRef();
  const enabled = tracked === null ? await repo.git.getBoolConfig('push.autoSetupRemote') : null;
  return upstreamText(tracked, enabled) ?? 'none yet: git push -u ' + pushRemote(remotes) + ' ' + branch.name;
}

function pushRemote(remotes: readonly string[]): string {
  return remotes.includes('origin') ? 'origin' : remotes[0]!;
}

function machineSettings(repo: RepoState, auth: AuthState): void {
  const id = repo.identity;
  out.heading('This machine');
  out.field('default', person(id.machineName, id.machineEmail, 'none'));
  out.field('helper', repo.helper ?? 'none');
  out.field('gh active', activeAccountLabel(auth));
}

function person(name: string | null, email: string | null, absent: string): string {
  if (!name && !email) return absent;
  return (name ?? '?') + ' <' + (email ?? '?') + '>';
}

function originOf(repo: RepoState): string {
  if (!repo.originUrl) return 'no remote';
  return (repo.owner ?? 'unknown') + '  ' + out.dim('(' + repo.provider.label + ')');
}

function pushesAs(repo: RepoState): string {
  if (!repo.originUrl) return 'no remote to push to';
  if (repo.credentialKeys.length === 0) return 'not pinned by repown on ' + repo.provider.label;
  return repo.identity.account ?? 'NOT SET LOCALLY';
}

type LoadedRegistry = Result<Registry>;

interface Recorded {
  readonly key: string;
  readonly entry: Account;
}

// A registry that cannot be read is reported. Skipping it would look like "none recorded".
function accountOf(repo: RepoState, registry: LoadedRegistry): string {
  if (!registry.ok) return 'registry could not be read: ' + registry.error;
  const pinned = pinnedAccount(repo);
  if (pinned === null) return noted('not pinned', recordedList(registry.value));
  const found = recordedAs(registry.value, pinned);
  if (!found) return noted(pinned, 'not in this machine\'s registry');
  const aside = matchesRecord(repo, found.entry) ? 'recorded' : recordedAside(found.entry);
  return noted(found.key, aside);
}

function recordedList(registry: Registry): string {
  const keys = Object.keys(registry.accounts);
  return keys.length === 0 ? 'none recorded' : 'recorded: ' + keys.join(', ');
}

function recordedAside(entry: Account): string {
  return 'recorded as ' + person(entry.name, entry.email, '?');
}

function noted(value: string, aside: string): string {
  return value + '  ' + out.dim('(' + aside + ')');
}

function pinnedAccount(repo: RepoState): string | null {
  return repo.identity.owner ?? repo.identity.account;
}

function recordedAs(registry: Registry, pinned: string): Recorded | null {
  const wanted = pinned.toLowerCase();
  const key = Object.keys(registry.accounts).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? null : { key, entry: registry.accounts[key]! };
}

function matchesRecord(repo: RepoState, entry: Account): boolean {
  const id = repo.identity;
  return id.name === entry.name && id.email?.toLowerCase() === entry.email.toLowerCase();
}

interface Problem { readonly what: string; readonly fix: string; }

/** Read only when status finds no problem: otherwise the problem comes first. */
async function pushBlockers(repo: RepoState, account: string): Promise<Blocker[]> {
  const facts = await readPushFacts(repo.git, await readUnpushed(repo.git));
  const guarded = repo.guard !== 'off' || repo.hook?.redirected === true;
  // The upstream field already says how to push a branch without one: not a warning here.
  return blockers(facts, { email: repo.identity.email ?? '', account, autoUpstream: true, guarded });
}

/** First among the warnings. An owner the origin warning names is not said twice. */
function printBlockers(found: readonly Blocker[], ownerWarned: boolean): void {
  for (const blocker of found) {
    if (blocker.kind === 'owner' && ownerWarned) continue;
    const [first = '', ...rest] = blocker.lines;
    out.warn('push', printable(first));
    for (const line of rest) out.detail(printable(line));
  }
}

interface StatusEnd {
  readonly repo: RepoState;
  readonly problems: readonly Problem[];
  readonly blockers: readonly Blocker[];
  readonly warnings: readonly string[];
  readonly account: string;
  readonly ghNote: boolean;
}

function closeStatus(end: StatusEnd): void {
  out.note('');
  out.note(closingLine(end));
}

function closingLine(end: StatusEnd): string {
  if (end.problems.length > 0) return tally(end.problems.length, end.warnings.length) + setupHint(end.repo);
  const blocking = end.blockers.filter((blocker) => blocker.blocks);
  const [first] = blocking;
  // What blocks nothing (the guard is off) is still a warning, and counted as one.
  const quiet = end.blockers.filter((blocker) => !blocker.blocks).map(() => 'push');
  if (!first) return readyLine(end.repo, end.account, [...quiet, ...end.warnings], end.ghNote);
  const more = blocking.length > 1 ? ' (and ' + (blocking.length - 1) + ' more above)' : '';
  return 'the next push will fail: ' + printable(first.summary) + more;
}

const GH_OPTIONAL = ' · gh: optional (see the note above)';

function readyLine(repo: RepoState, account: string, warnings: readonly string[], ghNote: boolean): string {
  const head = repo.credentialKeys.length === 0
    ? 'ready: commits use ' + account + '; pushes use this host\'s own sign-in'
    : 'ready: commits and pushes use ' + account;
  if (warnings.length > 0) return head + ' · ' + howMany(warnings.length, 'warning');
  return ghNote ? head + GH_OPTIONAL : head;
}

function setupHint(repo: RepoState): string {
  return identityProblems(repo).length > 0 ? ': run repown setup' : '';
}

function tally(problems: number, warnings: number): string {
  const parts = [howMany(problems, 'problem'), howMany(warnings, 'warning')];
  return parts.filter((part) => part.length > 0).join(', ');
}

function howMany(count: number, word: string): string {
  if (count === 0) return '';
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function collectProblems(repo: RepoState, auth: AuthState): Problem[] {
  const gh: Problem[] = auth.ghIsHelper ? [{
    what: 'gh is the git credential helper, so only its ACTIVE account can ' +
          'authenticate and every clone pinned elsewhere is prompted for a password.',
    fix: 'repown fix',
  }] : [];
  return [...identityProblems(repo), ...gh];
}

const SETUP_FIX = 'repown setup   (or: repown use <account>)';

export function identityProblems(repo: RepoState): Problem[] {
  const id = repo.identity;
  if (!isPinned(id)) {
    return [{
      what: 'This clone sets no identity of its own, so it inherits the machine default (' +
            (id.inheritedEmail ?? 'nothing') + ').',
      fix: SETUP_FIX,
    }];
  }
  if (repo.credentialKeys.length === 0 || id.account) return [];
  return [{
    what: 'No account is pinned, so pushes fall back to the machine default (' +
          (id.inheritedAccount ?? 'nothing') + ').',
    fix: SETUP_FIX,
  }];
}

async function reportWarnings(repo: RepoState, auth: AuthState, registry: LoadedRegistry, found: readonly Blocker[]): Promise<readonly string[]> {
  const tags = ['origin', 'account', 'guard', 'submodule', 'helper', 'gh'] as const;
  const foreignOwner = await originForeign(repo);
  printBlockers(found, foreignOwner);
  const fired = [
    foreignOwner && ownerWarning(repo),
    accountWarning(repo, registry),
    guardWarning(repo),
    submoduleWarning(repo),
    helperWarning(repo, auth),
    ghWarning(pinnedAccount(repo), auth),
  ];
  return tags.filter((_, i) => fired[i]);
}

function accountShown(repo: RepoState, registry: LoadedRegistry): string {
  const pinned = pinnedAccount(repo);
  if (pinned === null) return repo.identity.email ?? 'this clone\'s identity';
  if (!registry.ok) return pinned;
  return recordedAs(registry.value, pinned)?.key ?? pinned;
}

function accountWarning(repo: RepoState, registry: LoadedRegistry): boolean {
  if (!registry.ok) return registryUnread();
  const pinned = pinnedAccount(repo);
  const found = pinned === null ? null : recordedAs(registry.value, pinned);
  if (!found || matchesRecord(repo, found.entry)) return false;
  const id = repo.identity;
  out.warn('account', 'this clone commits as ' + person(id.name, id.email, '?') +
    ', but ' + found.key + ' is recorded as ' + person(found.entry.name, found.entry.email, '?') + '.');
  out.detail('fix: repown use ' + found.key);
  return true;
}

/** A pinned credential key is only as good as the helper reading it. gh as helper is a problem, reported elsewhere. */
function helperWarning(repo: RepoState, auth: AuthState): boolean {
  if (repo.credentialKeys.length === 0 || auth.helperIsGcm || auth.ghIsHelper) return false;
  if (!auth.helper) {
    out.warn('helper', 'no credential helper is set, so the pinned account selects no credential; git will prompt on push.');
  } else {
    out.warn('helper', '"' + auth.helper + '" serves credentials here, and repown cannot tell whether it honours the pinned account.');
  }
  out.detail('see: repown doctor   (Git Credential Manager is the helper repown pins for)');
  return true;
}

/**
 * A submodule is a clone of its own, with its own config and hooks. This clone's
 * guard never sees its commits -- not even when `git push --recurse-submodules`
 * publishes them from here.
 */
function submoduleWarning(repo: RepoState): boolean {
  if (!repo.root || !existsSync(join(repo.root, '.gitmodules'))) return false;
  out.warn('submodule', 'this clone has submodules; each is a separate clone with its own identity and hook.');
  out.detail('pin and guard each one too:  git submodule foreach "repown use <account> && repown guard on"');
  return true;
}

/**
 * An organisation is never an account name, so a bare owner-vs-account
 * comparison warns on every org repository -- which is most of them at work.
 */
async function originForeign(repo: RepoState): Promise<boolean> {
  const allowed = await allowedOwners(repo.git, repo.identity.owner ?? repo.identity.account);
  return !!repo.owner && allowed.length > 0 && !allowed.includes(repo.owner.toLowerCase());
}

function ownerWarning(repo: RepoState): boolean {
  if (!repo.owner) return false;
  out.warn('origin', 'origin belongs to "' + repo.owner + '", which is not an owner this clone pushes to.');
  out.detail('if that is an organisation you belong to:');
  out.detail('  git config --local --add repown.allowOwner ' + shellWord(repo.owner));
  return true;
}

function registryUnread(): boolean {
  out.warn('account', 'the account registry could not be read, so this clone\'s account was not compared with it.');
  out.detail('see: repown accounts list');
  return true;
}

/**
 * The unknown case is REPORTED, never skipped. Guarding this on the active
 * account being truthy is how a failed lookup used to make the whole warning
 * disappear, leaving output that looked clean rather than uncertain.
 * `account` is the clone's account: repown.account, else the credential username.
 */
type GhAuth = Pick<AuthState, 'ghPresent' | 'gh'>;

export interface GhAdvice {
  readonly level: 'warn' | 'note';
  readonly text: string;
  readonly detail: string;
}

export function ghAdvice(account: string | null, auth: GhAuth): GhAdvice | null {
  if (auth.ghPresent && !auth.gh.ok) return unverifiedGh();
  const active = ghActiveOther(account, auth);
  if (!active || account === null) return null;
  return { level: 'note', text: ghActiveText(active), detail: ghFix(account, auth) };
}

function unverifiedGh(): GhAdvice {
  return { level: 'warn', text: GH_UNVERIFIED, detail: 'check it yourself: gh auth status' };
}

function ghActiveText(active: string): string {
  return 'active as "' + active + '", so `gh pr create` here would act as that account. ' +
    'git pushes are unaffected; this only matters if you use gh here.';
}

const GH_UNVERIFIED = 'could not be queried, so who `gh pr create` would act as is UNVERIFIED.';

/** `gh auth switch` only works for a login gh already lists, and only in gh's spelling. */
function ghFix(account: string, auth: GhAuth): string {
  const login = ghReportedLogin(account, auth);
  if (login !== null) return 'fix: gh auth switch -u ' + login;
  return 'fix: repown use ' + account + ' --gh   (signs ' + account + ' in to gh)';
}

function ghReportedLogin(account: string, auth: GhAuth): string | null {
  if (!auth.gh.ok) return null;
  const wanted = account.toLowerCase();
  const found = auth.gh.value.accounts.find((item) => item.login.toLowerCase() === wanted);
  return found === undefined ? null : found.login;
}

function ghActiveOther(account: string | null, auth: GhAuth): string | null {
  if (!auth.gh.ok || !account || !auth.gh.value.active) return null;
  const active = auth.gh.value.active;
  return active.toLowerCase() === account.toLowerCase() ? null : active;
}

function ghWarning(account: string | null, auth: AuthState): boolean {
  const advice = ghAdvice(account, auth);
  if (advice?.level !== 'warn') return false;
  out.warn('gh', advice.text);
  out.detail(advice.detail);
  return true;
}

/** After the identity line, so a terminal shows the pass before this note. */
function printGhNote(account: string | null, auth: AuthState): boolean {
  const advice = ghAdvice(account, auth);
  if (advice?.level !== 'note') return false;
  out.noted('gh', advice.text);
  out.detail(advice.detail);
  return true;
}

function guardWarning(repo: RepoState): boolean {
  if (repo.guard === 'on') return false;
  if (repo.hook?.redirected) {
    out.warn('guard', 'core.hooksPath makes git run hooks from another tool\'s directory; repown does not install there.');
    out.detail('guard this clone from that tool\'s pre-push hook: repown guard check --remote="$1" --url="$2"');
    out.detail('(that hook must pass its stdin through: the refs being pushed arrive there)');
  } else if (repo.guard === 'off') {
    out.warn('guard', 'off -- pushes are not checked. Enable it: repown guard on');
  } else {
    out.warn('guard', 'a pre-push hook repown did not write is installed; it was left alone.');
    out.detail('read it first; if it is safe to drop, delete ' + (repo.hook?.path ?? 'it') + ', then run: repown guard on');
  }
  return true;
}
