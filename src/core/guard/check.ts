// The check the pre-push hook runs.
//
// IT VERIFIES THE COMMITS BEING PUSHED, not the configuration as it stands now.
// That distinction is the whole reason this exists. A config check answers "is
// the identity right at this moment", which a commit authored in the window
// before setup -- or on a branch, or introduced by a merge, rebase, cherry-pick
// or an IDE -- passes cleanly as soon as the config is put right afterwards. The
// push is recoverable; the commit object is not. `user.email` is baked into its
// author and committer fields, and on a public repository that is permanent.
//
// The hook receives, on stdin:
//
//     <local ref> <local sha> <remote ref> <remote sha>
//
// which is exactly the set of commits about to be published. The previous design
// read that and threw it away.

import type { Git, CommitIdentity } from '../git.ts';
import { parseGitUrl } from '../url.ts';
import { providerFor } from '../hosts/index.ts';
import { readIdentity, legacyAccountKey } from '../identity.ts';

/** The null object id: 40 zeros, or 64 in a SHA-256 repository. */
const isZero = (sha: string): boolean => /^0+$/.test(sha);
const MIRROR_KEY = 'repown.mirrorBranch';
const ALLOW_OWNER_KEY = 'repown.allowOwner';
const ALLOW_TAGGER_KEY = 'repown.allowTagger';

/** Variables that override the identity the guard just validated, or bypass the check gh performs. */
const HOSTILE = [
  ['GIT_AUTHOR_EMAIL', 'silently overrides the author address of every commit made'],
  ['GIT_COMMITTER_EMAIL', 'silently overrides the committer address of every commit made'],
  ['GH_TOKEN', 'makes gh serve this token whatever account git asked for, skipping its own username check'],
  ['GITHUB_TOKEN', 'makes gh serve this token whatever account git asked for, skipping its own username check'],
] as const;

export interface PushRef {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

export interface Refusal {
  readonly reason: string;
  readonly detail: readonly string[];
}

export interface CheckInput {
  readonly git: Git;
  readonly remote: string;
  readonly url: string;
  readonly stdin: string;
  /** Told about a check that could not run -- which must never look like one that passed. */
  readonly onNote?: (note: string) => void;
}

export function parsePushRefs(stdin: string): PushRef[] {
  return stdin.split(/\r?\n/).flatMap((raw) => {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 4) return [];
    return [{ localRef: parts[0]!, localSha: parts[1]!, remoteRef: parts[2]!, remoteSha: parts[3]! }];
  });
}

export async function check(input: CheckInput): Promise<Refusal[]> {
  const hostile = checkEnvironment();
  if (hostile.length > 0) return hostile;

  const url = parseGitUrl(input.url);
  const provider = providerFor(url);
  const credentialKey = url ? provider.credentialKeys(url)[0] ?? null : null;
  const identity = await readIdentity(input.git, credentialKey);

  if (!identity.email) {
    return [{
      reason: 'This clone sets no identity of its own, so the guard cannot tell ' +
              'your commits from anyone else’s.',
      detail: ['fix: repown use <account>'],
    }];
  }
  const owner = url ? provider.ownerOf(url) : null;
  const legacy = !identity.owner && url ? await input.git.getConfig(legacyAccountKey(url), 'local') : null;
  const allowed = await allowedOwners(input.git, identity.owner ?? identity.account ?? legacy);
  const destination = checkDestination({ url, owner, allowed }, input.onNote);
  return [...destination, ...await checkCommits(input, identity.email)];
}

function checkEnvironment(): Refusal[] {
  return HOSTILE.flatMap(([name, why]) => {
    if (!process.env[name]) return [];
    return [{
      reason: name + ' is set, and it ' + why + '.',
      detail: ['unset it and push again, or push with --no-verify if you meant it'],
    }];
  });
}

/**
 * Owners this clone may legitimately push to: the pinned account, plus anything
 * listed in repown.allowOwner.
 *
 * THE LIST EXISTS BECAUSE ORGANISATIONS ARE NOT ACCOUNTS. A repository owned by
 * an organisation you belong to has an owner that is not, and never will be,
 * your account name -- so comparing the two refuses every push to every org
 * repository, which is most working repositories in most jobs.
 *
 * Organisation membership could be resolved from the host API instead. It is
 * not, deliberately: that would put a network call and an auth dependency in the
 * pre-push path, where a rate limit or an offline laptop would turn into a
 * failed push. An explicit local list is offline, instant, and readable.
 */
export async function allowedOwners(git: Git, account: string | null): Promise<string[]> {
  // LOCAL only: "per repository, explicitly". A global entry would widen every clone.
  const extra = await git.getAllConfig(ALLOW_OWNER_KEY, 'local');
  return [...(account ? [account] : []), ...extra].map((owner) => owner.toLowerCase());
}

/**
 * The destination actually being pushed to, parsed as a URL.
 *
 * NOT a substring match on the whole remote string, which is what this replaced:
 * `https://octocat@github.com/SomeoneElse/repo` contains the pinned account in
 * its USERINFO and passed on that alone, while pushing somewhere else entirely.
 */
interface Destination {
  readonly url: ReturnType<typeof parseGitUrl>;
  readonly owner: string | null;
  readonly allowed: readonly string[];
}

function checkDestination({ url, owner, allowed }: Destination, onNote?: (note: string) => void): Refusal[] {
  const skipped = !url ? 'the remote is not a URL (a local path?)'
    : !owner ? 'no owner can be read from ' + url.host + ' URLs'
    : allowed.length === 0 ? 'no account is recorded for this clone -- run: repown use <account>'
    : null;
  if (skipped) { onNote?.('destination not checked: ' + skipped); return []; }
  if (allowed.includes(owner!.toLowerCase())) return [];
  return [{
    reason: 'This push goes to "' + printable(owner!) + '", which this clone is not pinned to.',
    detail: [
      'destination: ' + printable(redacted(url!.raw)),
      'allowed here: ' + allowed.join(', '),
      'if that owner is legitimate -- an organisation you belong to, say:',
      '  git config --local --add ' + ALLOW_OWNER_KEY + ' ' + shellWord(printable(owner!)),
    ],
  }];
}

async function checkCommits(input: CheckInput, expected: string): Promise<Refusal[]> {
  const mirror = await input.git.getConfig(MIRROR_KEY, 'local');
  const refusals: Refusal[] = [];

  for (const ref of parsePushRefs(input.stdin)) {
    if (isZero(ref.localSha)) continue;              // a deletion publishes nothing
    const upstreamShaped = ref.remoteRef === 'refs/heads/' + mirror || ref.remoteRef.startsWith('refs/tags/');
    const exclude = mirror && upstreamShaped
      ? ['--not', '--remotes']                          // fork: on any remote, upstream included
      : ['--not', '--remotes=' + input.remote];
    refusals.push(...await checkTaggers(input.git, ref, expected));
    refusals.push(...await checkRange(input, { ref, exclude }, expected));
  }
  return refusals;
}

/**
 * An annotated tag's tagger is published with it, as permanently as an author.
 * Whether a tag OBJECT is already public cannot be told offline -- its commit
 * being on a remote proves nothing, since a tag made here under the wrong
 * identity can sit on an upstream commit too. So a fork pushing upstream's tags
 * names upstream's taggers explicitly, repo-locally: repown.allowTagger.
 */
async function checkTaggers(git: Git, ref: PushRef, expected: string): Promise<Refusal[]> {
  const taggers = await git.taggersOf(ref.localSha);
  if (!taggers.ok) {
    return [{
      reason: 'The guard could not read the tag bound for ' + ref.remoteRef + '. Refusing rather than passing unchecked.',
      detail: ['git said: ' + taggers.error],
    }];
  }
  const allowed = [expected, ...await git.getAllConfig(ALLOW_TAGGER_KEY, 'local')];
  const foreign = taggers.value.filter((tagger) => !allowed.some((address) => matches(tagger, address)));
  if (foreign.length === 0) return [];
  return [{
    reason: 'The tag bound for ' + ref.remoteRef + ' was not tagged as ' + expected + '.',
    detail: [...foreign.map((tagger) => '  tagger  ' + (printable(tagger) || '(none)')), '',
      'The tagger address becomes permanent once pushed.',
      'an upstream tag on a fork? allow its tagger: git config --local --add ' + ALLOW_TAGGER_KEY + ' <address>'],
  }];
}

/** One pushed ref, and the commits that do not count because a remote already has them. */
interface Pushed {
  readonly ref: PushRef;
  readonly exclude: readonly string[];
}

/**
 * The mirror exemption is OPT-IN, per repository, via repown.mirrorBranch. A branch
 * that only ever fast-forwards to upstream commits nobody here authored would
 * otherwise be refused for carrying their addresses -- but defaulting to an
 * exemption is how the previous design silently exempted every feature branch, so
 * an unset key means no exemption at all.
 *
 * EVEN THEN THE MIRROR IS CHECKED, just against a wider exclusion: a commit on
 * ANY remote-tracking ref (upstream's included) is public already and does not
 * count, but one on no remote was made here. Skipping the ref outright let
 * `git push origin feature:master` publish anything at all.
 *
 * BOTH RANGES EXCLUDE WHAT THE REMOTE ALREADY HAS. The question this guard asks
 * is which addresses THIS push makes permanent -- and a commit already on a
 * remote-tracking ref made its own permanent when it was first published.
 * Pushing it onto a second branch publishes nothing new. Without the exclusion
 * a fork that merges upstream into its release branch is refused for every
 * upstream commit in the merge, one step after pushing those very commits to
 * its own mirror branch: a false positive on its most routine operation.
 *
 * The cost is bounded, and worth naming rather than hiding. A STALE
 * remote-tracking ref -- a branch deleted or force-pushed on the server -- can
 * exclude a commit that is no longer really published. `git fetch --prune`
 * corrects it, and the new-branch path has always carried the same exposure.
 * The mirror's wider exclusion adds one more: a commit that only a PRIVATE
 * remote carries (a work remote, say) is not public, yet does not count there.
 */
async function checkRange(input: CheckInput, { ref, exclude }: Pushed, expected: string): Promise<Refusal[]> {
  const range = await rangeFor(input.git, ref, exclude);
  const commits = await input.git.identitiesIn(range);
  if (!commits.ok) {
    return [{
      reason: 'The guard could not read the commits bound for ' + ref.remoteRef +
              ', so it cannot tell whether they are yours. Refusing rather than passing unchecked.',
      detail: ['reason: ' + commits.error, unreadableHint(commits.error)],
    }];
  }
  const foreign = commits.value.filter((commit) =>
    !matches(commit.authorEmail, expected) || !matches(commit.committerEmail, expected));
  if (foreign.length === 0) return [];
  const refusal = foreignRefusal(ref, foreign, expected);
  // The remote's tip was not here, so every commit it lacks locally was checked;
  // some of those may well be on the remote already.
  const widened = !isZero(ref.remoteSha) && range[0] === ref.localSha;
  return [widened ? { ...refusal, detail: [...refusal.detail, 'if they are already on the remote: git fetch, then push again'] } : refusal];
}

/**
 * `remoteSha..localSha` needs remoteSha to exist HERE. A tip someone else pushed,
 * never fetched, does not -- a force-push over it is the routine case -- so the
 * push is checked as if the branch were new: everything the remote's
 * tracking refs do not already carry.
 */
async function rangeFor(git: Git, ref: PushRef, exclude: readonly string[]): Promise<string[]> {
  const known = !isZero(ref.remoteSha) && await git.hasCommit(ref.remoteSha);
  return known ? [ref.remoteSha + '..' + ref.localSha, ...exclude] : [ref.localSha, ...exclude];
}

/** Each commit shows the address that is WRONG -- the committer's, when the author is right. */
function foreignRefusal(ref: PushRef, foreign: readonly CommitIdentity[], expected: string): Refusal {
  const shown = foreign.slice(0, 10).map((commit) => {
    const wrong = [...new Set([commit.authorEmail, commit.committerEmail])]
      .filter((address) => !matches(address, expected));
    return '  ' + commit.sha.slice(0, 9) + '  ' + printable(wrong.join(', ')) + '  ' + printable(commit.subject);
  });
  const more = foreign.length > shown.length ? ['  ... and ' + (foreign.length - shown.length) + ' more'] : [];

  return {
    reason: foreign.length + ' commit(s) bound for ' + ref.remoteRef +
            ' were not authored as ' + expected + ', or were committed by someone else.',
    detail: [...shown, ...more, '', 'These addresses become permanent once pushed.'],
  };
}

/** A fetch cures a missing object; it does nothing for history git printed in a shape repown cannot parse. */
function unreadableHint(error: string): string {
  return /account for every commit|unreadable commit record/.test(error)
    ? 'the history could not be parsed reliably; inspect it yourself before any --no-verify'
    : 'try: git fetch, then push again';
}

function matches(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

/** Text a commit's author chose: control characters could rewrite the terminal around the refusal. */
function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

/**
 * A URL as it may be shown: the WHOLE userinfo is replaced. A token is often the
 * username itself (`https://ghp_...@github.com/`), not only a password.
 */
function redacted(raw: string): string {
  return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1***@');
}

/** An owner comes from the URL, so a suggested command must quote it for the shell. */
export function shellWord(value: string): string {
  return /^[\w.@-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}
