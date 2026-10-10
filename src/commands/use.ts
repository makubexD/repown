// Pin this clone to one account.
//
// A clone belongs to ONE account, permanently. This writes repo-local git config
// and is not run again:
//
//   user.name
//   user.email
//   user.useConfigOnly            git refuses to invent an identity from the hostname
//   repown.account                whose clone this is -- the guard's destination check
//   credential.<host>.username    which stored credential serves this remote (GitHub over https)
//
// NOTHING IS WRITTEN TO THE REPOSITORY. All of it lands in .git/config, which git
// never tracks -- which is what keeps a name or address out of a public repo, and
// also why this is per clone: a second machine, or a re-clone, runs it again.
//
// You do not switch this afterwards, and you do not need to. `--gh` keeps the
// GitHub CLI on the same account: `gh auth switch` when gh already lists it,
// and, in a terminal, `gh auth login` when it does not. After `repown fix`
// neither changes which account git pushes as.

import { inspectRepo, inspectAuth, type AuthState, type RepoState } from '../core/inspect.ts';
import { pinIdentity, type PinOutcome } from '../core/identity.ts';
import { lookupAccount, saveAccount, type Account } from '../core/registry.ts';
import {
  ghSwitch, ghLogin, readGhLoginVersion, type GhLoginError, type GhLoginVersion,
} from '../core/credential/gh.ts';
import { ALLOW_OWNER_BY_HAND, allowOwnerCommand, allowedOwners } from '../core/guard/check.ts';
import { readUnpushed, unpushedLines } from '../core/unpushed.ts';
import { ask, interactive } from '../ui/prompt.ts';
import { flagString, flagBool, gitFor, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

/** The last hint while the guard is off; `repown setup` leaves it out when its next step turns the guard on. */
export const NEXT_GUARD = '  Next: repown guard on    (check every push before it leaves)';

export default {
  summary: 'pin this clone to an account (repown use <account>)',
  positionals: { min: 1, max: 1, label: '<account>' },
  options: [
    { name: 'gh', kind: 'boolean', help: "also switch gh's active account, or sign the account in to gh when needed (in a terminal)" },
    { name: 'name', kind: 'string', help: 'the commit author name (given with --email, skips the registry and the prompt)' },
    { name: 'email', kind: 'string', help: 'the commit author email (given with --name, skips the registry and the prompt)' },
  ],
  examples: ['repown use octocat', 'repown use octocat --gh'],

  async run(args: Args): Promise<number> {
    const account = args.positional[0]!;
    const git = gitFor(args);
    const repo = await inspectRepo(git);
    if (!repo.isRepo) { out.fail('use', 'Not a git repository: ' + git.cwd); return 1; }

    const values = await resolveAccount(account, repo, args);
    if (!values) return 1;

    if (!reportPinned(await pinIdentity(git, { ...values, account }, repo.credentialKeys))) return 1;
    out.pass('identity', out.printable(values.name + ' <' + values.email + '>  push-as:' + account));

    if (flagBool(args, 'gh')) await applyGh(account, repo);
    await reportConcerns(account, repo, values.email);
    return 0;
  },
} satisfies Command;

/** False, naming every key, when any write failed: nothing reports success it did not have. */
function reportPinned(outcomes: readonly PinOutcome[]): boolean {
  const failed = outcomes.filter((outcome) => !outcome.written);
  if (failed.length === 0) return true;
  out.fail('use', 'could not write ' + failed.length + ' of ' + outcomes.length + ' keys.');
  for (const outcome of failed) out.detail(outcome.key);
  out.detail('this clone is NOT pinned -- nothing here reports success it did not have.');
  return false;
}

/**
 * Flags first, then the registry, then ask -- with the host only suggesting the
 * prompt's defaults. The registry is why this is usually instant.
 */
async function resolveAccount(
  account: string,
  repo: RepoState,
  args: Args,
): Promise<Account | null> {
  const flagged = { name: flagString(args, 'name'), email: flagString(args, 'email') };
  if (flagged.name && flagged.email) return { name: flagged.name, email: flagged.email };

  const lookup = await lookupAccount(account);
  if (!lookup.ok) { out.fail('use', lookup.error); return null; }
  const recorded = lookup.value;
  const name = flagged.name ?? recorded?.name;
  const email = flagged.email ?? recorded?.email;
  if (name && email) return { name, email };

  return askAndRecord(account, repo, { name, email });
}

async function askAndRecord(
  account: string,
  repo: RepoState,
  known: { name: string | undefined; email: string | undefined },
): Promise<Account | null> {
  // Checked BEFORE asking the host for a suggestion: with no terminal there is
  // nobody to suggest to, and the lookup is a network call.
  if (!interactive()) {
    out.fail('use', 'no record of "' + account + '" and no terminal to ask.');
    out.detail('record it once:  repown accounts add ' + account + ' --name "..." --email "..."');
    return null;
  }
  const suggested = (await repo.provider.resolveProfile?.(account)) ?? {};
  out.line();
  out.line('  No record of "' + account + '" yet. Asking once, then never again.');
  const entry = await askProfile({
    name: offered(known.name) ?? suggested.name ?? offered(account) ?? '', email: offered(known.email) ?? suggested.email,
  }, repo.provider.id);
  if (!entry) return null;

  const saved = await saveAccount(account, entry);
  if (!saved.ok) out.warn('accounts', 'pinned, but not recorded: ' + out.printable(saved.error));
  out.line();
  return entry;
}

/** A default worth offering: one printable() would change would be drawn raw, and saved if accepted. */
function offered(value: string | null | undefined): string | undefined {
  return value && out.printable(value) === value ? value : undefined;
}

async function askProfile(defaults: { name: string; email: string | undefined }, host: string): Promise<Account | null> {
  const name = await ask('Commit name', defaults.name);
  if (!name.ok) { out.fail('use', name.error); return null; }
  const email = await ask('Commit email', defaults.email);
  if (!email.ok) { out.fail('use', email.error); return null; }
  return { name: name.value, email: email.value, host };
}

export type GhAction = 'switch' | 'login' | 'advise' | 'none';

/**
 * What `--gh` should do. An account gh already lists is a switch even when it
 * is already active: `switchCli` always runs `gh auth switch`. `none` means gh
 * could not be queried, and the caller keeps that same switch attempt.
 */
export function ghAction(account: string, auth: AuthState, interactive: boolean): GhAction {
  if (!auth.gh.ok) return 'none';
  if (knownToGh(account, auth)) return 'switch';
  return interactive ? 'login' : 'advise';
}

function knownToGh(account: string, auth: AuthState): boolean {
  if (!auth.gh.ok) return false;
  const wanted = account.toLowerCase();
  return auth.gh.value.accounts.some((item) => item.login.toLowerCase() === wanted);
}

const ASK = 'When gh asks "Authenticate Git with your GitHub credentials?", ';

const ANSWER_NO = ASK + 'type n and press Enter. Enter alone means Yes, and Yes makes gh ' +
  'answer git\'s sign-in requests for every repository.';

const PIN_KEPT = 'This clone is already pinned. Cancelling the browser (Ctrl-C) only skips the gh sign-in.';

/** What to say about "Authenticate Git with your GitHub credentials?". Null when gh will not ask. */
export function ghCredentialAnswer(auth: AuthState): string | null {
  if (auth.ghIsHelper) return null;
  if (auth.helper === null) return ANSWER_NO;
  return storesIn(auth.helperIsGcm, auth.helper);
}

function storesIn(gcm: boolean, helper: string): string {
  const where = gcm ? 'Git Credential Manager' : helper;
  return ASK + 'press Enter (Yes): it also stores this sign-in in ' + where + ', so the first push won\'t ask again.';
}

async function applyGh(account: string, repo: RepoState): Promise<void> {
  const auth = await inspectAuth(repo.git, repo.credentialUrl ?? undefined);
  const action = ghAction(account, auth, interactive());
  if (action === 'advise') return notSignedIn(account);
  if (action === 'login') return signInToGh(account, repo, auth);
  await switchCli(account);
}

function notSignedIn(account: string): void {
  out.warn('gh', account + ' isn\'t signed in to gh');
  out.detail('fix: gh auth login, then repown use ' + account + ' --gh');
}

async function signInToGh(account: string, repo: RepoState, before: AuthState): Promise<void> {
  const verdict = await readGhLoginVersion();
  if (verdict !== 'ready') return oldGh(account, verdict);
  announceLogin(account, before);
  const logged = await ghLogin('github.com');
  if (!logged.ok) return loginFailed(logged.error);
  await reportLogin(account, repo, before);
}

function oldGh(account: string, verdict: Exclude<GhLoginVersion, 'ready'>): void {
  out.warn('gh', versionReason(verdict));
  out.detail('fix: upgrade gh to 2.40.0 or newer, then repown use ' + account + ' --gh');
}

function versionReason(verdict: Exclude<GhLoginVersion, 'ready'>): string {
  if (verdict === 'old') return 'this gh replaces an account on login instead of adding one';
  return 'gh\'s version could not be read, so sign-in was skipped';
}

export function announceLogin(account: string, auth: AuthState): void {
  out.note('Your browser will open. Sign in to GitHub as ' + account + ' there.');
  out.detail('a private window helps if the browser is signed in as someone else.');
  out.note(PIN_KEPT);
  const answer = ghCredentialAnswer(auth);
  if (answer !== null) out.note(answer);
}

function loginFailed(failure: GhLoginError): void {
  if (failure.kind === 'cancelled') { out.warn('gh', 'gh sign-in cancelled'); return; }
  out.warn('gh', failure.reason);
  out.detail('fix: gh auth login');
}

async function reportLogin(account: string, repo: RepoState, before: AuthState): Promise<void> {
  const after = await inspectAuth(repo.git, repo.credentialUrl ?? undefined);
  reportActive(account, after);
  if (!before.ghIsHelper && after.ghIsHelper) helperTakenOver();
}

export function reportActive(account: string, auth: AuthState): void {
  if (!auth.gh.ok) return unreadActive(auth.gh.error);
  const who = auth.gh.value.active;
  if (who !== null && who.toLowerCase() === account.toLowerCase()) {
    out.pass('gh', 'signed in as ' + account + ', now gh\'s active account');
    return;
  }
  if (who === null) return noActive();
  otherActive(account, who);
}

function unreadActive(error: string): void {
  out.warn('gh', 'gh signed in, but who is active could not be read (' + error + ')');
  out.detail('check it yourself: gh auth status');
}

function noActive(): void {
  out.warn('gh', 'gh signed in, but no account is active');
  out.detail('check it yourself: gh auth status');
}

function otherActive(account: string, who: string): void {
  out.warn('gh', 'gh signed in as "' + who + '", not ' + account);
  out.detail('sign out of github.com in the browser (or use a private window), then: repown use ' + account + ' --gh');
}

function helperTakenOver(): void {
  out.warn('gh', 'gh now answers git\'s sign-in requests, so clones of your other accounts get password prompts');
  out.detail('fix: repown fix');
}

async function switchCli(account: string): Promise<void> {
  const switched = await ghSwitch(account);
  if (switched.ok) out.pass('gh', 'active account switched to ' + account);
  else out.warn('gh', 'could not switch: ' + switched.error);
}

/** Everything that is now true but not yet right. Warnings, never refusals. */
async function reportConcerns(account: string, repo: RepoState, email: string): Promise<void> {
  await reportUnpushed(repo, email, account);
  if (repo.credentialKeys.length === 0 && repo.url) {
    out.warn('host', repo.credentialHost.label + ' credentials are not pinned by repown.');
    out.detail('commits are pinned and the guard still runs; only credential');
    out.detail('selection is left to whatever already serves this host.');
  }
  await ownerConcern(account, repo);
  await credentialConcern(account, repo);
  if (repo.guard === 'off' && !repo.hook?.redirected) {
    out.line();
    out.line(NEXT_GUARD);
  }
}

/** A warning only. Rewriting the commits stays the owner's call (ADR-013). */
async function reportUnpushed(repo: RepoState, email: string, account: string): Promise<void> {
  const [first, ...rest] = unpushedLines(await readUnpushed(repo.git), email, account);
  if (!first) return;
  out.warn('commits', first);
  for (const line of rest) out.detail(line);
}

async function ownerConcern(account: string, repo: RepoState): Promise<void> {
  if (!repo.owner || repo.owner.toLowerCase() === account.toLowerCase()) return;
  if ((await allowedOwners(repo.git, account)).includes(repo.owner.toLowerCase())) return;
  out.warn('origin', 'origin belongs to "' + out.printable(repo.owner) + '", not "' + out.printable(account) + '".');
  out.detail('normal for an organisation repository. To stop the guard refusing it:');
  out.detail('  ' + (allowOwnerCommand(repo.owner) ?? ALLOW_OWNER_BY_HAND));
}

/** Only where use pinned a credential: elsewhere pushes use the host's own sign-in, as setup's credentialGap says. */
async function credentialConcern(account: string, repo: RepoState): Promise<void> {
  if (repo.credentialKeys.length === 0) return;
  const auth = await inspectAuth(repo.git, repo.credentialUrl ?? undefined);
  if (auth.ghIsHelper) {
    out.warn('helper', 'gh is still the git credential helper, so this pin is not honoured.');
    out.detail('fix: repown fix');
  } else if (auth.gcmPresent && auth.stored.ok && !auth.stored.value.includes(account)) {
    out.line();
    out.line('  No stored credential for "' + account + '" yet -- the first push signs in');
    out.line('  once, then never again. Verify it afterwards: repown doctor');
  }
}
