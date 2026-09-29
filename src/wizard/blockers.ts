// What will make the next commit, pull or push fail in this clone, from facts read once.
//
// Pure: setup's review and settled screen, its closing line and `repown status` all
// read the same list, so none of them can say "done" or "ready" over a push the guard
// (or git) is about to refuse. A fact that could not be read is a blocker of its own,
// never an absence (a skipped check must not look passed).

import type { Result } from '../core/result.ts';
import { unpushedLines, foreignCount, type UnpushedCommit, type UnpushedFact } from '../core/unpushed.ts';
import { shellWord } from '../core/guard/check.ts';
import type { Divergence, PushDestination, PushFacts } from '../core/push-state.ts';

export type { PushFacts } from '../core/push-state.ts';

/** Who the clone is (or is about to be) pinned to, and whether new branches get an upstream. */
export interface PushChoice {
  readonly email: string;
  readonly account: string;
  readonly autoUpstream: boolean;
}

export interface Blocker {
  /** A few words for the closing line: `the next push will fail: <summary>`. */
  readonly summary: string;
  /** What to show: the fact first, then how to fix it. */
  readonly lines: readonly string[];
}

const TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN'];

export function blockers(facts: PushFacts, choice: PushChoice): Blocker[] {
  const branch = facts.unpushed.branch ?? 'HEAD';
  return [
    ...unpushedBlocker(facts.unpushed, choice),
    ...elsewhereBlocker(facts.elsewhere, facts.destination, branch, choice.email),
    ...signinBlocker(facts.signinKey, branch, choice.account),
    ...facts.env.map((name) => envBlocker(name, choice.email)),
    ...facts.configOverrides.map((key) => configBlocker(key, choice.email)),
    ...ownerBlocker(facts.destination, branch, choice.account),
    ...divergenceBlocker(facts.divergence, branch),
    ...upstreamBlocker(facts, branch, choice.autoUpstream),
    ...(facts.detached ? [detachedBlocker()] : []),
  ];
}

function unpushedBlocker(fact: UnpushedFact, choice: PushChoice): Blocker[] {
  const lines = unpushedLines(fact, choice.email, choice.account);
  if (lines.length === 0) return [];
  if (!fact.commits.ok) return [{ summary: 'unpushed commits could not be read', lines }];
  const count = foreignCount(fact, choice.email);
  return [{ summary: count + (count === 1 ? ' commit' : ' commits') + ' by another address', lines }];
}

function signinBlocker(key: string | null, branch: string, account: string): Blocker[] {
  if (!key) return [];
  return [{
    summary: 'the branch pushes with its own sign-in',
    lines: [key + ' carries its own sign-in, so pushes from ' + branch + ' use it, not ' + account],
  }];
}

/** Counted with the guard's own exclusion, so a fork's upstream commits are not missed. */
function elsewhereBlocker(elsewhere: Result<readonly UnpushedCommit[]>, destination: PushDestination | null, branch: string, email: string): Blocker[] {
  if (!elsewhere.ok) return [{ summary: 'commits on other remotes could not be read', lines: ['commits on other remotes could not be read (' + elsewhere.error + ')'] }];
  const count = foreignCount({ branch, commits: elsewhere, unknown: null }, email);
  if (count === 0) return [];
  const where = destination?.remote ?? 'the destination';
  const noun = count === 1 ? '1 commit' : count + ' commits';
  return [{
    summary: noun + ' from another remote',
    lines: [noun + ' on ' + branch + ' by another address ' + (count === 1 ? 'is' : 'are') + ' on another remote but not on ' + where +
      ': the guard will refuse them (a fork mirroring upstream? see repown.mirrorBranch)'],
  }];
}

function configBlocker(key: string, email: string): Blocker {
  return {
    summary: key + ' is set',
    lines: [key + ' is set in git config: commits made here won' + "'" + 't use ' + email + ' (unset it: git config --unset ' + key + ')'],
  };
}

function envBlocker(name: string, email: string): Blocker {
  const identity = TOKENS.includes(name) ? '' : ': commits made here won\'t use ' + email + ',';
  const joiner = identity ? ' and' : ':';
  return {
    summary: name + ' is set',
    lines: [name + ' is set in this shell' + identity + joiner + ' the guard refuses every push while it is set (unset it)'],
  };
}

function ownerBlocker(destination: PushDestination | null, branch: string, account: string): Blocker[] {
  if (!destination) return [];
  const owner = destination.owner.toLowerCase();
  if (owner === account.toLowerCase() || destination.allowed.includes(owner)) return [];
  const where = destination.remote ?? 'its URL';
  return [{
    summary: 'the push goes to "' + destination.owner + '"',
    lines: [branch + ' pushes to ' + where + ', owned by "' + destination.owner + '", not ' + account +
      ': the guard will refuse it. If you belong there: git config --local --add repown.allowOwner ' + shellWord(destination.owner)],
  }];
}

function divergenceBlocker(divergence: Result<Divergence | null>, branch: string): Blocker[] {
  if (!divergence.ok) {
    return [{ summary: branch + ' could not be compared with its upstream', lines: [branch + ' could not be compared with its upstream (' + divergence.error + ')'] }];
  }
  const found = divergence.value;
  if (!found || found.behind === 0 || found.ahead === 0) return [];
  return [{
    summary: branch + ' has diverged from ' + found.tracked,
    lines: [branch + ' is ' + found.behind + ' behind and ' + found.ahead + ' ahead of ' + found.tracked +
      ': push and pull fail until you git pull --rebase'],
  }];
}

function upstreamBlocker(facts: PushFacts, branch: string, autoUpstream: boolean): Blocker[] {
  if (facts.upstream !== 'missing' || autoUpstream) return [];
  const remote = shellWord(facts.destination?.remote ?? 'origin');
  return [{ summary: branch + ' has no upstream', lines: [branch + ' has no upstream: the first push needs git push -u ' + remote + ' ' + shellWord(branch)] }];
}

function detachedBlocker(): Blocker {
  return { summary: 'HEAD is detached', lines: ['HEAD is detached: git pull and a plain git push fail here; git switch to a branch first'] };
}
