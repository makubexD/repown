// Commits on the current branch that no remote-tracking ref has.
//
// Pinning does not rewrite them (ADR-013). The guard refuses them at push
// (ADR-002, ADR-011), so `use` and setup's review say so first. The read is
// `git log HEAD --not --remotes` through Git.identitiesIn, the same parser the
// guard uses. scan's address totals are a different question: every ref, counts
// only, and setup loads them only for the guard question.

import type { CommitIdentity, Git } from './git.ts';
import { ok, type Result } from './result.ts';

export interface UnpushedCommit {
  readonly authorEmail: string;
  readonly committerEmail: string;
}

/** `branch` is null on a detached HEAD: nothing to check. A failed `commits` is unknown, not clean. */
export interface UnpushedFact {
  readonly branch: string | null;
  readonly commits: Result<readonly UnpushedCommit[]>;
}

const ADDRESS_CAP = 3;
const REAUTHOR = 're-author them (git rebase with --exec "git commit --amend --no-edit --reset-author"), or pin that address';

export async function readUnpushed(git: Git): Promise<UnpushedFact> {
  const head = await git.currentBranch();
  if (head?.kind !== 'branch') return { branch: null, commits: ok([]) };
  return { branch: head.name, commits: await commitsOf(git) };
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

/** Lines to show. Empty when there is nothing to say. The first is the fact; any other is how to fix it. */
export function unpushedLines(fact: UnpushedFact, email: string): string[] {
  if (fact.branch === null) return [];
  if (!fact.commits.ok) return [unread(fact.branch, fact.commits.error)];
  return foreignLines(fact.branch, fact.commits.value, email);
}

function foreignLines(branch: string, commits: readonly UnpushedCommit[], email: string): string[] {
  const found = collect(commits, fold(email));
  if (found.count === 0) return [];
  return [sentence(branch, found), REAUTHOR];
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
