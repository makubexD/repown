// What `repown` with no arguments prints: is this clone set up correctly?
//
// Three separate things decide who you are here, and they fail differently:
//
//   user.name / user.email            who AUTHORED the commit
//   credential.<host>.username        which stored credential serves the push
//   the CLI's active account          who `gh pr create` acts as
//
// All three are printed, because the one that is invisible is the one that
// catches people out. This reports; it changes nothing.

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

export default {
  summary: 'the state of this repository and this machine (the default)',

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

    summary(repo, auth, registry);
    const problems = collectProblems(repo, auth);
    await reportWarnings(repo, auth, registry);
    return verdict(repo, auth, problems);
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

function summary(repo: RepoState, auth: AuthState, registry: LoadedRegistry): void {
  out.heading(STATUS_TITLE);
  out.line(place(repo));
  cloneSettings(repo, registry);
  machineSettings(repo, auth);
  out.line();
}

function place(repo: RepoState): string {
  return '  ' + (repo.root ?? repo.git.cwd) + '  ' + headLabel(repo.branch);
}

function headLabel(branch: RepoState['branch']): string {
  if (branch?.kind === 'detached') return '(detached at ' + branch.hash + ')';
  if (branch?.kind === 'branch') return '(branch ' + branch.name + ')';
  return '(unknown)';
}

function cloneSettings(repo: RepoState, registry: LoadedRegistry): void {
  const id = repo.identity;
  out.heading('This clone');
  out.field('commits as', person(id.name, id.email, 'NOT SET LOCALLY'));
  out.field('pushes as', pushesAs(repo));
  out.field('account', accountOf(repo, registry));
  out.field('origin', originOf(repo));
  out.field('push guard', repo.guard);
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

function collectProblems(repo: RepoState, auth: AuthState): Problem[] {
  const gh: Problem[] = auth.ghIsHelper ? [{
    what: 'gh is the git credential helper, so only its ACTIVE account can ' +
          'authenticate and every clone pinned elsewhere is prompted for a password.',
    fix: 'repown fix',
  }] : [];
  return [...identityProblems(repo), ...gh];
}

function identityProblems(repo: RepoState): Problem[] {
  const id = repo.identity;
  if (!isPinned(id)) {
    return [{
      what: 'This clone sets no identity of its own, so it inherits the machine default (' +
            (id.inheritedEmail ?? 'nothing') + ').',
      fix: 'repown use <account>',
    }];
  }
  if (repo.credentialKeys.length === 0 || id.account) return [];
  return [{
    what: 'No account is pinned, so pushes fall back to the machine default (' +
          (id.inheritedAccount ?? 'nothing') + ').',
    fix: 'repown use <account>',
  }];
}

async function reportWarnings(repo: RepoState, auth: AuthState, registry: LoadedRegistry): Promise<void> {
  await ownerWarning(repo);
  accountWarning(repo, registry);
  guardWarning(repo);
  submoduleWarning(repo);
  helperWarning(repo, auth);
  ghWarning(repo.identity.account, auth);
}

function accountWarning(repo: RepoState, registry: LoadedRegistry): void {
  if (!registry.ok) return;
  const pinned = pinnedAccount(repo);
  const found = pinned === null ? null : recordedAs(registry.value, pinned);
  if (!found || matchesRecord(repo, found.entry)) return;
  const id = repo.identity;
  out.warn('account', 'this clone commits as ' + person(id.name, id.email, '?') +
    ', but ' + found.key + ' is recorded as ' + person(found.entry.name, found.entry.email, '?') + '.');
  out.detail('fix: repown use ' + found.key);
}

/** A pinned credential key is only as good as the helper reading it. gh as helper is a problem, reported elsewhere. */
function helperWarning(repo: RepoState, auth: AuthState): void {
  if (repo.credentialKeys.length === 0 || auth.helperIsGcm || auth.ghIsHelper) return;
  if (!auth.helper) {
    out.warn('helper', 'no credential helper is set, so the pinned account selects no credential; git will prompt on push.');
  } else {
    out.warn('helper', '"' + auth.helper + '" serves credentials here, and repown cannot tell whether it honours the pinned account.');
  }
  out.detail('see: repown doctor   (Git Credential Manager is the helper repown pins for)');
}

/**
 * A submodule is a clone of its own, with its own config and hooks. This clone's
 * guard never sees its commits -- not even when `git push --recurse-submodules`
 * publishes them from here.
 */
function submoduleWarning(repo: RepoState): void {
  if (!repo.root || !existsSync(join(repo.root, '.gitmodules'))) return;
  out.warn('submodule', 'this clone has submodules; each is a separate clone with its own identity and hook.');
  out.detail('pin and guard each one too:  git submodule foreach "repown use <account> && repown guard on"');
}

/**
 * An organisation is never an account name, so a bare owner-vs-account
 * comparison warns on every org repository -- which is most of them at work.
 */
async function ownerWarning(repo: RepoState): Promise<void> {
  const allowed = await allowedOwners(repo.git, repo.identity.owner ?? repo.identity.account);
  if (!repo.owner || allowed.length === 0 || allowed.includes(repo.owner.toLowerCase())) return;
  out.warn('origin', 'origin belongs to "' + repo.owner + '", which is not an owner this clone pushes to.');
  out.detail('if that is an organisation you belong to:');
  out.detail('  git config --local --add repown.allowOwner ' + shellWord(repo.owner));
}

/**
 * The unknown case is REPORTED, never skipped. Guarding this on the active
 * account being truthy is how a failed lookup used to make the whole warning
 * disappear, leaving output that looked clean rather than uncertain.
 */
function ghWarning(account: string | null, auth: AuthState): void {
  if (auth.ghPresent && !auth.gh.ok) {
    out.warn('gh', 'could not be queried, so who `gh pr create` would act as is UNVERIFIED.');
    out.detail('check it yourself: gh auth status');
  } else if (auth.gh.ok && auth.gh.value.active && account &&
             auth.gh.value.active.toLowerCase() !== account.toLowerCase()) {
    out.warn('gh', 'active as "' + auth.gh.value.active + '", so `gh pr create` here would act as that account.');
    out.detail('fix: gh auth switch -u ' + account);
  }
}

function guardWarning(repo: RepoState): void {
  if (repo.guard === 'on') return;
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
}
