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

import type { Git } from '../git.ts';
import { parseGitUrl } from '../url.ts';
import { providerFor } from '../hosts/index.ts';
import { readIdentity } from '../identity.ts';

const ZERO = '0'.repeat(40);
const MIRROR_KEY = 'gid.mirrorBranch';
const ALLOW_OWNER_KEY = 'gid.allowOwner';

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

  const { git } = input;
  const url = parseGitUrl(input.url);
  const provider = providerFor(url);
  const credentialKey = url ? provider.credentialKeys(url)[0] ?? null : null;
  const identity = await readIdentity(git, credentialKey);

  if (!identity.email) {
    return [{
      reason: 'This clone sets no identity of its own, so the guard cannot tell ' +
              'your commits from anyone else’s.',
      detail: ['fix: gid use <account>'],
    }];
  }

  const owner = url ? provider.ownerOf(url) : null;
  const allowed = await allowedOwners(git, identity.account);
  const destination = checkDestination(url, owner, allowed);
  const commits = await checkCommits(input, identity.email);
  return [...destination, ...commits];
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
 * listed in gid.allowOwner.
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
  const extra = await git.getAllConfig(ALLOW_OWNER_KEY);
  return [...(account ? [account] : []), ...extra].map((owner) => owner.toLowerCase());
}

/**
 * The destination actually being pushed to, parsed as a URL.
 *
 * NOT a substring match on the whole remote string, which is what this replaced:
 * `https://octocat@github.com/SomeoneElse/repo` contains the pinned account in
 * its USERINFO and passed on that alone, while pushing somewhere else entirely.
 */
function checkDestination(
  url: ReturnType<typeof parseGitUrl>,
  owner: string | null,
  allowed: readonly string[],
): Refusal[] {
  if (!url || !owner || allowed.length === 0) return [];
  if (allowed.includes(owner.toLowerCase())) return [];
  return [{
    reason: 'This push goes to "' + owner + '", which this clone is not pinned to.',
    detail: [
      'destination: ' + url.raw,
      'allowed here: ' + allowed.join(', '),
      'if that owner is legitimate -- an organisation you belong to, say:',
      '  git config --local --add ' + ALLOW_OWNER_KEY + ' ' + owner,
    ],
  }];
}

async function checkCommits(input: CheckInput, expected: string): Promise<Refusal[]> {
  const mirror = await input.git.getConfig(MIRROR_KEY);
  const refusals: Refusal[] = [];

  for (const ref of parsePushRefs(input.stdin)) {
    if (ref.localSha === ZERO) continue;              // a deletion publishes nothing
    if (mirror && ref.remoteRef === 'refs/heads/' + mirror) continue;
    refusals.push(...await checkRange(input, ref, expected));
  }
  return refusals;
}

/**
 * The mirror exemption is OPT-IN, per repository, via gid.mirrorBranch. A branch
 * that only ever fast-forwards to upstream commits nobody here authored would
 * otherwise be refused for carrying their addresses -- but defaulting to an
 * exemption is how the previous design left five of six branches unguarded, so
 * an unset key means no exemption at all.
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
 */
async function checkRange(input: CheckInput, ref: PushRef, expected: string): Promise<Refusal[]> {
  const range = ref.remoteSha === ZERO
    ? [ref.localSha, '--not', '--remotes=' + input.remote]
    : [ref.remoteSha + '..' + ref.localSha, '--not', '--remotes=' + input.remote];

  const commits = await input.git.identitiesIn(range);
  const foreign = commits.filter((commit) =>
    !matches(commit.authorEmail, expected) || !matches(commit.committerEmail, expected));
  if (foreign.length === 0) return [];

  const shown = foreign.slice(0, 10).map((commit) =>
    '  ' + commit.sha.slice(0, 9) + '  ' + commit.authorEmail + '  ' + commit.subject);
  const more = foreign.length > shown.length ? ['  ... and ' + (foreign.length - shown.length) + ' more'] : [];

  return [{
    reason: foreign.length + ' commit(s) bound for ' + ref.remoteRef +
            ' were not authored as ' + expected + '.',
    detail: [...shown, ...more, '', 'These addresses become permanent once pushed.'],
  }];
}

function matches(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}
