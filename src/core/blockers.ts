// What will make the next commit, pull or push fail in this clone, from facts read once.
//
// Pure: setup's review and settled screen, its closing line and `repown status` all
// read the same list, so none of them can say "done" or "ready" over a push the guard
// (or git) is about to refuse. A fact that could not be read is a blocker of its own,
// never an absence (a skipped check must not look passed). What only the guard would
// refuse is still said with the guard off, as a warning that blocks nothing.

import type { Result } from './result.ts';
import { unpushedLines, foreignCount, type UnpushedCommit, type UnpushedFact } from './unpushed.ts';
import { shellWord } from './guard/check.ts';
import type { Divergence, PushDestination, PushFacts } from './push-state.ts';

export type { PushFacts } from './push-state.ts';

/** Who the clone is (or is about to be) pinned to, whether new branches get an upstream, and whether pushes are guarded. */
export interface PushChoice {
  readonly email: string;
  readonly account: string;
  readonly autoUpstream: boolean;
  /** A pre-push hook will check the push: repown's guard, or a hook this clone does not own (it may call it). */
  readonly guarded: boolean;
}

/** Which fact it is, so a report that already shows one of them its own way can leave it out. */
export type BlockerKind = 'unpushed' | 'elsewhere' | 'signin' | 'env' | 'config' | 'owner' | 'divergence' | 'upstream' | 'detached';

export interface Blocker {
  readonly kind: BlockerKind;
  /** A few words for the closing line: `the next push will fail: <summary>`. */
  readonly summary: string;
  /** What to show: the fact first, then how to fix it. */
  readonly lines: readonly string[];
  /** False: said, but it stops nothing, since only the guard would refuse it and the guard is off. */
  readonly blocks: boolean;
}

const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN'];

export function blockers(facts: PushFacts, choice: PushChoice): Blocker[] {
  const branch = facts.unpushed.branch ?? 'HEAD';
  return [
    ...unpushedBlocker(facts.unpushed, choice),
    ...elsewhereBlocker(facts.elsewhere, facts.destination, branch, choice),
    ...signinBlocker(facts, branch, choice.account),
    ...facts.env.map((name) => envBlocker(name, choice)),
    ...facts.configOverrides.map((key) => configBlocker(key, choice.email)),
    ...ownerBlocker(facts.destination, branch, choice),
    ...divergenceBlocker(facts.divergence, branch),
    ...upstreamBlocker(facts, branch, choice.autoUpstream),
    ...(facts.detached ? [detachedBlocker()] : []),
  ];
}

/** What the guard does with them: refuses, or, while it is off, lets them through. */
function guardWord(guarded: boolean, many: boolean): string {
  if (guarded) return 'the guard will refuse ' + (many ? 'them' : 'it');
  return 'the guard is off, so ' + (many ? 'they push as they are' : 'it pushes as it is');
}

function unpushedBlocker(fact: UnpushedFact, choice: PushChoice): Blocker[] {
  const lines = unpushedLines(fact, choice.email, choice.account, choice.guarded);
  if (lines.length === 0) return [];
  if (!fact.commits.ok) return [{ kind: 'unpushed', summary: 'unpushed commits could not be read', lines, blocks: choice.guarded }];
  const count = foreignCount(fact, choice.email);
  return [{ kind: 'unpushed', summary: count + (count === 1 ? ' commit' : ' commits') + ' by another address', lines, blocks: choice.guarded }];
}

/** Where a remote names the same repository, the fix is setup's repoint. */
function signinBlocker(facts: PushFacts, branch: string, account: string): Blocker[] {
  const key = facts.signinKey;
  if (!key) return [];
  const fix = facts.repoint?.key === key ? ': point it back at ' + facts.repoint.remote + ' with repown setup --repoint' : '';
  return [{
    kind: 'signin',
    summary: 'the branch pushes with its own sign-in',
    lines: [key + ' carries its own sign-in, so pushes from ' + branch + ' use it, not ' + account + fix],
    blocks: true,
  }];
}

/** Counted with the guard's own exclusion, so a fork's upstream commits are not missed. */
function elsewhereBlocker(elsewhere: Result<readonly UnpushedCommit[]>, destination: PushDestination | null, branch: string, choice: PushChoice): Blocker[] {
  if (!elsewhere.ok) {
    return [{ kind: 'elsewhere', summary: 'commits on other remotes could not be read', lines: ['commits on other remotes could not be read (' + elsewhere.error + ')'], blocks: choice.guarded }];
  }
  const count = foreignCount({ branch, commits: elsewhere, unknown: null }, choice.email);
  if (count === 0) return [];
  const where = destination?.remote ?? 'the destination';
  const noun = count === 1 ? '1 commit' : count + ' commits';
  return [{
    kind: 'elsewhere',
    summary: noun + ' from another remote',
    lines: [noun + ' on ' + branch + ' by another address ' + (count === 1 ? 'is' : 'are') + ' on another remote but not on ' + where +
      ': ' + guardWord(choice.guarded, count > 1) + ' (a fork mirroring upstream? see repown.mirrorBranch)'],
    blocks: choice.guarded,
  }];
}

function configBlocker(key: string, email: string): Blocker {
  return {
    kind: 'config',
    summary: key + ' is set',
    lines: [key + " is set in git config: commits made here won't use " + email + ' (unset it: git config --unset ' + key + ')'],
    blocks: true,
  };
}

/** An identity variable still changes every commit; a token only matters to the guard. */
function envBlocker(name: string, choice: PushChoice): Blocker {
  const token = TOKENS.includes(name);
  const identity = token ? '' : ": commits made here won't use " + choice.email;
  const guard = choice.guarded ? 'the guard refuses every push while it is set'
    : token ? 'the guard is off, so it stops nothing now, but with the guard on every push is refused' : '';
  const joiner = !guard ? '' : identity ? ', and ' : ': ';
  return {
    kind: 'env',
    summary: name + ' is set',
    lines: [name + ' is set in this shell' + identity + joiner + guard + ' (unset it)'],
    blocks: choice.guarded || !token,
  };
}

function ownerBlocker(destination: PushDestination | null, branch: string, choice: PushChoice): Blocker[] {
  if (!destination) return [];
  const owner = destination.owner.toLowerCase();
  if (owner === choice.account.toLowerCase() || destination.allowed.includes(owner)) return [];
  const where = destination.remote ?? 'its URL';
  const guard = choice.guarded ? 'the guard will refuse it' : 'the guard is off, so it pushes there anyway';
  return [{
    kind: 'owner',
    summary: 'the push goes to "' + destination.owner + '"',
    lines: [branch + ' pushes to ' + where + ', owned by "' + destination.owner + '", not ' + choice.account +
      ': ' + guard + '. If you belong there: git config --local --add repown.allowOwner ' + shellWord(destination.owner)],
    blocks: choice.guarded,
  }];
}

function divergenceBlocker(divergence: Result<Divergence | null>, branch: string): Blocker[] {
  if (!divergence.ok) {
    return [{ kind: 'divergence', summary: branch + ' could not be compared with its upstream', lines: [branch + ' could not be compared with its upstream (' + divergence.error + ')'], blocks: true }];
  }
  const found = divergence.value;
  if (!found || found.behind === 0 || found.ahead === 0) return [];
  return [{
    kind: 'divergence',
    summary: branch + ' has diverged from ' + found.tracked,
    lines: [branch + ' is ' + found.behind + ' behind and ' + found.ahead + ' ahead of ' + found.tracked +
      ': push and pull fail until you git pull --rebase'],
    blocks: true,
  }];
}

function upstreamBlocker(facts: PushFacts, branch: string, autoUpstream: boolean): Blocker[] {
  if (facts.upstream !== 'missing' || autoUpstream) return [];
  const remote = shellWord(facts.destination?.remote ?? 'origin');
  return [{ kind: 'upstream', summary: branch + ' has no upstream', lines: [branch + ' has no upstream: the first push needs git push -u ' + remote + ' ' + shellWord(branch)], blocks: true }];
}

function detachedBlocker(): Blocker {
  return { kind: 'detached', summary: 'HEAD is detached', lines: ['HEAD is detached: git pull and a plain git push fail here; git switch to a branch first'], blocks: true };
}
