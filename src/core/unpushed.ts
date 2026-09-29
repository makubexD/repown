// Commits on the current branch that no remote-tracking ref has.
//
// Pinning does not rewrite them (ADR-013). The guard refuses them at push
// (ADR-002, ADR-011), so `use` and setup's review say so first, with a copyable
// `git rebase` onto the parent of the oldest of those commits (`--root` when it
// has none). The identities come from `git log` through Git.identitiesIn
// (`--no-show-signature`). The base is `rev-list` and `rev-parse` on Git.
// Where the branch pushes may have no remote-tracking ref at all; then the range can
// hold published commits, and the rebase is offered only for when it has none of
// them (push-destination.ts, ADR-025).
// scan's address totals are a different question: every ref, counts only, and
// setup loads them only for the guard question.

import type { CommitIdentity, Git } from './git.ts';
import { ok, type Result } from './result.ts';
import { unknownDestination, type UnknownDestination } from './push-destination.ts';
import { shellWord } from './guard/check.ts';

export interface UnpushedCommit {
  readonly authorEmail: string;
  readonly committerEmail: string;
}

/** `branch` is null on a detached HEAD: nothing to check. A failed `commits` is unknown, not clean. */
export interface UnpushedFact {
  readonly branch: string | null;
  readonly commits: Result<readonly UnpushedCommit[]>;
  /** `git rebase` target: a short sha, or `--root`. Null when there is no range to rebase. */
  readonly rebaseBase: string | null;
  /** Where the branch pushes, when no remote-tracking ref says what it already has. */
  readonly unknown: UnknownDestination | null;
}

const ADDRESS_CAP = 3;
const AMEND = '--exec "git commit --amend --no-edit --reset-author --allow-empty"';

export async function readUnpushed(git: Git): Promise<UnpushedFact> {
  const head = await git.currentBranch();
  if (head?.kind !== 'branch') return quiet(null);
  const commits = await commitsOf(git);
  if (!commits.ok || commits.value.length === 0) return { branch: head.name, commits, rebaseBase: null, unknown: null };
  const [base, unknown] = await Promise.all([rebaseBase(git), unknownDestination(git, head.name)]);
  return { branch: head.name, commits, rebaseBase: base, unknown };
}

function quiet(branch: string | null): UnpushedFact {
  return { branch, commits: ok([]), rebaseBase: null, unknown: null };
}

/** Parent of the oldest unpushed commit, or `--root` when that commit has none. */
async function rebaseBase(git: Git): Promise<string | null> {
  const oldest = await git.oldestIn(['HEAD', '--not', '--remotes']);
  if (!oldest) return null;
  return (await git.parentShort(oldest)) ?? '--root';
}

/** No commit yet is an empty list. A log git could not print stays an error. */
async function commitsOf(git: Git): Promise<Result<readonly UnpushedCommit[]>> {
  if (!await git.hasCommit('HEAD')) return ok([]);
  const found = await git.identitiesIn(['HEAD', '--not', '--remotes']);
  if (!found.ok) return found;
  return ok(found.value.map(brief));
}

function brief(commit: CommitIdentity): UnpushedCommit {
  return { authorEmail: commit.authorEmail, committerEmail: commit.committerEmail };
}

/**
 * Lines to show. Empty when there is nothing to say. The first is the fact; any other is how
 * to fix it. `account` is what to pin again to count again.
 */
export function unpushedLines(fact: UnpushedFact, email: string, account: string): string[] {
  if (fact.branch === null) return [];
  if (!fact.commits.ok) return [unread(fact.branch, fact.commits.error)];
  const found = collect(fact.commits.value, fold(email));
  if (found.count === 0) return [];
  return [sentence(fact.branch, found), ...advice(fact, found.count, account)];
}

/** Behind an unknown destination the rebase is right only when it has none of these commits. */
function advice(fact: UnpushedFact, count: number, account: string): string[] {
  const rebase = reauthorLine(count, fact.rebaseBase);
  if (!fact.unknown) return rebase;
  const holder = fact.unknown.kind === 'remote' ? show(fact.unknown.name) : 'it';
  return [unknownLine(fact.unknown, account), ...rebase.map((line) => 'if ' + holder + ' has none of them, ' + line)];
}

const SKIPPED = ' (the guard skips those)';

function unknownLine(unknown: UnknownDestination, account: string): string {
  const recount = 'then repown use ' + shellWord(show(account)) + ' to count again';
  if (unknown.kind === 'remote') {
    return show(unknown.name) + ' has no remote-tracking refs, so some of these may already be on it' + SKIPPED +
      ': git fetch ' + shellWord(show(unknown.name)) + ', ' + recount;
  }
  const lead = 'this branch pushes to a URL, not a remote, so some of these may already be there' + SKIPPED;
  if (!unknown.remote) return lead;
  const remote = shellWord(show(unknown.remote));
  return lead + ': git config --local ' + shellWord(show(unknown.key)) + ' ' + remote + ', git fetch ' + remote + ', ' + recount;
}

function reauthorLine(count: number, base: string | null): string[] {
  if (!base) return [];
  const them = count === 1 ? 'it' : 'them';
  return ['re-author ' + them + ': git rebase ' + base + ' ' + AMEND + ', or pin that address'];
}

interface Found {
  readonly count: number;
  readonly addresses: readonly string[];
}

function collect(commits: readonly UnpushedCommit[], wanted: string): Found {
  const foreign = commits.filter((commit) => !own(commit, wanted));
  return { count: foreign.length, addresses: distinct(foreign, wanted) };
}

function own(commit: UnpushedCommit, wanted: string): boolean {
  return fold(commit.authorEmail) === wanted && fold(commit.committerEmail) === wanted;
}

function distinct(commits: readonly UnpushedCommit[], wanted: string): string[] {
  const seen = new Map<string, string>();
  for (const address of commits.flatMap(both)) remember(seen, address, wanted);
  return [...seen.values()];
}

function both(commit: UnpushedCommit): string[] {
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

function sentence(branch: string, found: Found): string {
  const noun = found.count === 1 ? '1 commit' : found.count + ' commits';
  const verb = found.count === 1 ? 'is' : 'are';
  const them = found.count === 1 ? 'it' : 'them';
  return noun + ' on ' + show(branch) + ' not on any remote ' + verb + ' by ' +
    list(found.addresses) + '; the guard will refuse ' + them;
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

/** Control characters could redraw the terminal around a line taken from a commit. */
function show(text: string): string {
  const cleaned = text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
  return cleaned.length > 0 ? cleaned : '(none)';
}
