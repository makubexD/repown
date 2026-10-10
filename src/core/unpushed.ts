// Commits on the current branch that no remote-tracking ref has.
//
// Pinning does not rewrite them (ADR-013). The guard refuses them at push
// (ADR-002, ADR-011), so `use` and setup's review say so first, with a copyable
// `git rebase` onto the parent of the oldest of those commits by another address
// (`--root` when it has none), so the user's own commits before it are left alone.
// The identities come from `git log` through Git.identitiesIn (`--no-show-signature`),
// the parents from Git.firstParentsIn.
// Where the branch pushes may have no remote-tracking ref at all; then the range can
// hold published commits, and the rebase is offered only for when it has none of
// them (push-destination.ts, ADR-025).
// scan's address totals are a different question: every ref, counts only, and
// setup loads them only for the guard question.

import type { CommitIdentity, Git } from './git.ts';
import { ok, type Result } from './result.ts';
import { unknownDestination, type UnknownDestination } from './push-destination.ts';
import { copyableCommand, positional, shellWord } from './shell.ts';

export interface UnpushedCommit {
  readonly authorEmail: string;
  readonly committerEmail: string;
  /** Short hash of the first parent; null for a root commit. */
  readonly parent: string | null;
}

/** `branch` is null on a detached HEAD: nothing to check. A failed `commits` is unknown, not clean. */
export interface UnpushedFact {
  readonly branch: string | null;
  readonly commits: Result<readonly UnpushedCommit[]>;
  /** Where the branch pushes, when no remote-tracking ref says what it already has. */
  readonly unknown: UnknownDestination | null;
}

const ADDRESS_CAP = 3;
/** The one re-author command: the advice prints it, and `repown reauthor` runs it. */
export const AMEND_COMMAND = 'git commit --amend --no-edit --reset-author --allow-empty';
const AMEND = '--exec "' + AMEND_COMMAND + '"';

export async function readUnpushed(git: Git): Promise<UnpushedFact> {
  const head = await git.currentBranch();
  if (head?.kind !== 'branch') return quiet(null);
  const commits = await commitsOf(git);
  if (!commits.ok || commits.value.length === 0) return { branch: head.name, commits, unknown: null };
  return { branch: head.name, commits, unknown: await unknownDestination(git, head.name) };
}

function quiet(branch: string | null): UnpushedFact {
  return { branch, commits: ok([]), unknown: null };
}

/** No commit yet is an empty list. A log git could not print stays an error. */
async function commitsOf(git: Git): Promise<Result<readonly UnpushedCommit[]>> {
  if (!await git.hasCommit('HEAD')) return ok([]);
  const range = ['HEAD', '--not', '--remotes'];
  const [found, parents] = await Promise.all([git.identitiesIn(range), git.firstParentsIn(range)]);
  if (!found.ok) return found;
  if (!parents.ok) return parents;
  return ok(found.value.map((commit) => brief(commit, parents.value.get(commit.sha) ?? null)));
}

function brief(commit: CommitIdentity, parent: string | null): UnpushedCommit {
  return { authorEmail: commit.authorEmail, committerEmail: commit.committerEmail, parent };
}

/**
 * Lines to show. Empty when there is nothing to say. The first is the fact; any other is how
 * to fix it. `account` is what to pin again to count again. `guarded` false: the guard is off, so
 * the first line says they push as they are rather than that the guard will refuse them.
 */
export function unpushedLines(fact: UnpushedFact, email: string, account: string, guarded = true): string[] {
  if (fact.branch === null) return [];
  if (!fact.commits.ok) return [unread(fact.branch, fact.commits.error)];
  const found = collect(fact.commits.value, fold(email));
  if (found.count === 0) return [];
  return [sentence(fact.branch, found, guarded), ...advice(fact, found, account)];
}

/** How many unpushed commits carry an address other than `email`. Zero when they could not be read. */
export function foreignCount(fact: UnpushedFact, email: string): number {
  return fact.commits.ok ? collect(fact.commits.value, fold(email)).count : 0;
}

/** The addresses other than `email` on those commits, as they appear. Empty when they could not be read. */
export function foreignAddresses(fact: UnpushedFact, email: string): readonly string[] {
  return fact.commits.ok ? collect(fact.commits.value, fold(email)).addresses : [];
}

/** Behind an unknown destination the rebase is right only when it has none of these commits. */
function advice(fact: UnpushedFact, found: Found, account: string): string[] {
  const rebase = reauthorLine(found);
  if (!fact.unknown) return rebase;
  const holder = holderOf(fact.unknown);
  return [unknownLine(fact.unknown, account), ...rebase.map((line) => 'if ' + holder + ' has none of them, ' + line)];
}

function holderOf(unknown: UnknownDestination): string {
  return unknown.kind === 'remote' || unknown.kind === 'pushurl' || unknown.kind === 'untracked' ? show(unknown.name) : 'it';
}

/** The guard excludes what the pushed branch's remote tip has, not everything the remote holds. */
const GUARD = ' (the guard skips any already on the branch you push to)';
const THERE = ', so some of these may already be there' + GUARD;

function unknownLine(unknown: UnknownDestination, account: string): string {
  switch (unknown.kind) {
    case 'remote': return trackingLine(unknown.name, account);
    case 'pushurl': return show(unknown.name) + ' pushes to another URL than it fetches from' + THERE;
    case 'untracked': return untrackedLine(unknown.name, unknown.branch);
    case 'url': return urlLine(unknown.key, unknown.remote, account);
    case 'unnamed': return 'this branch pushes to "' + show(unknown.name) + '", which is not a remote here' + THERE;
    case 'unread': return 'the remotes could not be read, so some of these may already be on one' + GUARD;
  }
}

function trackingLine(name: string, account: string): string {
  const lead = show(name) + ' has no remote-tracking refs, so some of these may already be on it' + GUARD;
  const fetch = copyableCommand(['git', 'fetch', ...positional(show(name))]);
  return fetch ? lead + ': ' + fetch + ', ' + recount(account) : lead;
}

/** No fetch helps: the refspec itself leaves the branch out, so no tracking ref ever records it. */
function untrackedLine(remote: string, branch: string): string {
  return show(remote) + '\'s ' + show(branch) + ' is not fetched here (remote.' + show(remote) + '.fetch leaves it out)' + THERE;
}

function urlLine(key: string, remote: string | null, account: string): string {
  const lead = 'this branch pushes to a URL, not a remote' + THERE;
  if (!remote) return lead;
  const repoint = copyableCommand(['git', 'config', '--local', show(key), show(remote)]);
  const fetch = copyableCommand(['git', 'fetch', ...positional(show(remote))]);
  return repoint && fetch ? lead + ': ' + repoint + ', ' + fetch + ', ' + recount(account) : lead;
}

function recount(account: string): string {
  const word = shellWord(show(account));
  return word ? 'then repown use ' + word + ' to count again' : 'then run repown use again to count again';
}

/** Pinning is an alternative only when one address made them all. */
function reauthorLine(found: Found): string[] {
  const them = found.count === 1 ? 'it' : 'them';
  const pin = found.addresses.length === 1 ? ', or pin that address' : '';
  return ['re-author ' + them + ': git rebase ' + found.base + ' ' + AMEND + pin];
}

interface Found {
  readonly count: number;
  readonly addresses: readonly string[];
  /** Parent of the oldest foreign commit (git log lists newest first), or `--root`. */
  readonly base: string;
}

function collect(commits: readonly UnpushedCommit[], wanted: string): Found {
  const foreign = commits.filter((commit) => !own(commit, wanted));
  return { count: foreign.length, addresses: distinct(foreign, wanted), base: foreign.at(-1)?.parent ?? '--root' };
}

type Identity = Pick<UnpushedCommit, 'authorEmail' | 'committerEmail'>;

/** Author and committer are both `email`, in any case. */
export function isOwn(commit: Identity, email: string): boolean {
  return own(commit, fold(email));
}

/** The addresses other than `email` on these commits, each once, as first spelled. */
export function otherAddresses(commits: readonly Identity[], email: string): string[] {
  return distinct(commits, fold(email));
}

function own(commit: Identity, wanted: string): boolean {
  return fold(commit.authorEmail) === wanted && fold(commit.committerEmail) === wanted;
}

function distinct(commits: readonly Identity[], wanted: string): string[] {
  const seen = new Map<string, string>();
  for (const address of commits.flatMap(both)) remember(seen, address, wanted);
  return [...seen.values()];
}

function both(commit: Identity): string[] {
  return [commit.authorEmail, commit.committerEmail];
}

function remember(seen: Map<string, string>, address: string, wanted: string): void {
  const key = fold(address);
  if (key === wanted || seen.has(key)) return;
  seen.set(key, address);
}

function fold(address: string): string {
  return address.toLowerCase();
}

function sentence(branch: string, found: Found, guarded: boolean): string {
  const one = found.count === 1;
  const noun = one ? '1 commit' : found.count + ' commits';
  const guard = guarded ? 'the guard will refuse ' + (one ? 'it' : 'them')
    : 'the guard is off, so ' + (one ? 'it pushes as it is' : 'they push as they are');
  return noun + ' on ' + show(branch) + ' not on any remote ' + (one ? 'is' : 'are') + ' by ' +
    list(found.addresses) + '; ' + guard;
}

function list(addresses: readonly string[]): string {
  const shown = addresses.slice(0, ADDRESS_CAP).map(show);
  const rest = addresses.length - shown.length;
  const tail = rest > 0 ? ' and ' + rest + ' more' : '';
  return shown.join(', ') + tail;
}

function unread(branch: string, error: string): string {
  return 'commits on ' + show(branch) + ' not on any remote could not be read (' +
    show(error) + '), so repown can\'t say whether the guard will refuse them';
}

/**
 * Control characters could redraw the terminal around a line taken from a commit, and
 * bidi or zero-width ones make a copyable command read differently from what it pastes.
 */
function show(text: string): string {
  const cleaned = text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/g, '?');
  return cleaned.length > 0 ? cleaned : '(none)';
}
