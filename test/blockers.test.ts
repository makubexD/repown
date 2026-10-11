// What will make the next commit, pull or push fail, from facts read once (pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockers, type PushFacts } from '../src/core/blockers.ts';
import { ok, err } from '../src/core/result.ts';
import { allowOwnerCommand } from '../src/core/guard/check.ts';

const EMAIL = 'octocat@example.invalid';
const CHOICE = { email: EMAIL, account: 'octocat', autoUpstream: false, guarded: true };

function facts(overrides: Partial<PushFacts> = {}): PushFacts {
  return {
    unpushed: { branch: 'main', commits: ok([]), unknown: null },
    env: [],
    configOverrides: [],
    elsewhere: ok([]),
    signin: null,
    repoint: null,
    laterUrls: null,
    rewritable: null,
    destination: { remote: 'origin', owner: 'octocat', allowed: [] },
    divergence: ok(null),
    detached: false,
    upstream: 'set',
    ...overrides,
  };
}

const foreign = (count: number): PushFacts['unpushed'] => ({
  branch: 'main', unknown: null,
  commits: ok(Array.from({ length: count }, (_, index) =>
    ({ authorEmail: 'old@example.invalid', committerEmail: 'old@example.invalid', parent: index === count - 1 ? 'abc1234' : 'fff' }))),
});

const theirs = (count: number) => Array.from({ length: count }, () =>
  ({ authorEmail: 'upstream@example.invalid', committerEmail: 'upstream@example.invalid', parent: null }));

test('a clean clone has no blockers', () => {
  assert.deepEqual(blockers(facts(), CHOICE), []);
});

test('unpushed commits by another address: the unpushed lines, summarised by count', () => {
  const [first, ...rest] = blockers(facts({ unpushed: foreign(2) }), CHOICE);
  assert.equal(rest.length, 0);
  assert.equal(first!.summary, '2 commits by another address');
  assert.match(first!.lines[0]!, /^2 commits on main not on any remote are by old@example\.invalid; the guard will refuse them$/);
  assert.match(first!.lines[1]!, /^re-author them: git rebase abc1234 /);
  assert.equal(blockers(facts({ unpushed: foreign(1) }), CHOICE)[0]!.summary, '1 commit by another address');
});

test('unpushed commits that could not be read are a blocker, never clean', () => {
  const [first] = blockers(facts({ unpushed: { branch: 'main', commits: err('git log failed'), unknown: null } }), CHOICE);
  assert.equal(first!.summary, 'unpushed commits could not be read');
});

test('each identity variable set in this shell, by name', () => {
  const found = blockers(facts({ env: ['GIT_AUTHOR_EMAIL', 'GH_TOKEN'] }), CHOICE);
  assert.deepEqual(found.map((blocker) => blocker.summary), ['GIT_AUTHOR_EMAIL is set', 'GH_TOKEN is set']);
  assert.equal(found[0]!.lines[0], 'GIT_AUTHOR_EMAIL is set in this shell: commits made here won\'t use ' + EMAIL +
    ', and the guard refuses every push while it is set (unset it)');
  assert.equal(found[1]!.lines[0], 'GH_TOKEN is set in this shell: the guard refuses every push while it is set (unset it)');
});

test('a branch remote with its own sign-in names the key, never the URL', () => {
  const [first] = blockers(facts({ signin: { key: 'branch.main.remote' } }), CHOICE);
  assert.equal(first!.summary, 'the branch pushes with its own sign-in');
  assert.equal(first!.lines[0], 'branch.main.remote carries its own sign-in, so pushes from main use it, not octocat');
  const fixable = blockers(facts({ signin: { key: 'branch.main.remote' }, repoint: { key: 'branch.main.remote', remote: 'origin', tracked: true } }), CHOICE);
  assert.equal(fixable[0]!.lines[0], 'branch.main.remote carries its own sign-in, so pushes from main use it, not octocat: ' +
    'point it back at origin with repown setup --repoint');
});

test('commits another remote has but the destination lacks: the guard refuses them too', () => {
  const [first] = blockers(facts({ elsewhere: ok(theirs(3)), destination: { remote: 'origin', owner: 'octocat', allowed: [] } }), CHOICE);
  assert.equal(first!.summary, '3 commits from another remote');
  assert.equal(first!.lines[0], '3 commits on main by another address are on another remote but not on origin: ' +
    'the guard will refuse them (a fork mirroring upstream? see repown.mirrorBranch)');
  assert.equal(blockers(facts({ elsewhere: err('log failed') }), CHOICE)[0]!.summary, 'commits on other remotes could not be read');
});

test('author.email or committer.email in config outrank the pin', () => {
  const [first] = blockers(facts({ configOverrides: ['author.email'] }), CHOICE);
  assert.equal(first!.summary, 'author.email is set');
  assert.equal(first!.lines[0], "author.email is set in git config: commits made here won't use " + EMAIL + ' (unset it: git config --unset author.email)');
});

test('a destination owned by someone else, not allowed here', () => {
  const org = { remote: 'upstream', owner: 'octo-org', allowed: [] };
  const [first] = blockers(facts({ destination: org }), CHOICE);
  assert.equal(first!.summary, 'the push goes to "octo-org"');
  assert.equal(first!.lines[0], 'main pushes to upstream, owned by "octo-org", not octocat: the guard will refuse it. ' +
    'If you belong there: git config --local --add repown.allowOwner octo-org');
  assert.deepEqual(blockers(facts({ destination: { ...org, allowed: ['octo-org'] } }), CHOICE), []);
  assert.deepEqual(blockers(facts({ destination: { remote: 'origin', owner: 'OctoCat', allowed: [] } }), CHOICE), []);
  assert.deepEqual(blockers(facts({ destination: null }), CHOICE), []);
});

test('diverged from the tracked branch: pull first; only ahead or only behind is fine', () => {
  const [first] = blockers(facts({ divergence: ok({ tracked: 'origin/main', behind: 1, ahead: 4 }) }), CHOICE);
  assert.equal(first!.summary, 'main has diverged from origin/main');
  assert.equal(first!.lines[0], 'main is 1 behind and 4 ahead of origin/main: push and pull fail until you git pull --rebase');
  assert.deepEqual(blockers(facts({ divergence: ok({ tracked: 'origin/main', behind: 0, ahead: 4 }) }), CHOICE), []);
  assert.deepEqual(blockers(facts({ divergence: ok({ tracked: 'origin/main', behind: 3, ahead: 0 }) }), CHOICE), []);
  const unread = blockers(facts({ divergence: err('rev-list failed') }), CHOICE);
  assert.equal(unread[0]!.summary, 'main could not be compared with its upstream');
});

test('no upstream: a blocker only while push.autoSetupRemote stays off', () => {
  const [first] = blockers(facts({ upstream: 'missing' }), CHOICE);
  assert.equal(first!.summary, 'main has no upstream');
  assert.equal(first!.lines[0], 'main has no upstream: the first push needs git push -u origin main');
  assert.deepEqual(blockers(facts({ upstream: 'missing' }), { ...CHOICE, autoUpstream: true }), []);
});

test('a detached HEAD', () => {
  const [first] = blockers(facts({ detached: true, unpushed: { branch: null, commits: ok([]), unknown: null } }), CHOICE);
  assert.equal(first!.summary, 'HEAD is detached');
  assert.equal(first!.lines[0], 'HEAD is detached: git pull and a plain git push fail here; git switch to a branch first');
});

test('a sign-in git adds by rewriting the push URL names the remote, never a rule or a URL', () => {
  const [first] = blockers(facts({ signin: { remote: 'origin' } }), CHOICE);
  assert.equal(first!.summary, 'the branch pushes with its own sign-in');
  assert.equal(first!.lines[0], "origin's push URL, as git resolves it, carries its own sign-in, so pushes from main use it, not octocat");
  assert.equal(first!.blocks, true);
});

test('a later push URL the guard refuses is named by owner and host, with the command that allows it', () => {
  const laterUrls = { remote: 'origin', owners: [{ owner: 'octo-org', host: 'GitHub' }], allowed: [] };
  const [first] = blockers(facts({ laterUrls }), CHOICE);
  assert.equal(first!.kind, 'pushurls');
  assert.equal(first!.summary, 'origin also pushes to "octo-org"');
  assert.equal(first!.lines[0], 'origin also pushes to "octo-org" (GitHub), not octocat: the guard will refuse that URL ' +
    'while the first takes the push. If you belong there: ' + allowOwnerCommand('octo-org'));
  assert.equal(first!.blocks, true);
  const off = blockers(facts({ laterUrls }), { ...CHOICE, guarded: false });
  assert.match(off[0]!.lines[0]!, /the guard is off, so the push goes there too\./);
  assert.equal(off[0]!.blocks, false);
});

test('later URLs name each refused owner once, with one command each', () => {
  const owners = [{ owner: 'octo-org', host: 'GitHub' }, { owner: 'Octo-Org', host: 'GitHub' }, { owner: 'octo-work', host: 'GitHub' }];
  const [first] = blockers(facts({ laterUrls: { remote: 'origin', owners, allowed: [] } }), CHOICE);
  assert.equal(first!.lines[0], 'origin also pushes to "octo-org" (GitHub), "octo-work" (GitHub), not octocat: the guard ' +
    'will refuse those URLs while the first takes the push. If you belong there: ' +
    allowOwnerCommand('octo-org') + ' and ' + allowOwnerCommand('octo-work'));
});

test('no later-URL line when every owner is allowed, or when the first URL is already refused', () => {
  const allowed = { remote: 'origin', owners: [{ owner: 'Octo-Org', host: 'GitHub' }], allowed: ['octo-org'] };
  assert.deepEqual(blockers(facts({ laterUrls: allowed }), CHOICE), []);
  const mine = { remote: 'origin', owners: [{ owner: 'OctoCat', host: 'GitHub' }], allowed: [] };
  assert.deepEqual(blockers(facts({ laterUrls: mine }), CHOICE), []);
  const laterUrls = { remote: 'origin', owners: [{ owner: 'octo-work', host: 'GitHub' }], allowed: [] };
  const both = blockers(facts({ laterUrls, destination: { remote: 'origin', owner: 'octo-org', allowed: [] } }), CHOICE);
  assert.deepEqual(both.map((blocker) => blocker.kind), ['owner'], 'the owner line already stops the push');
});

test('a push straight to a URL git may rewrite says repown cannot tell where it lands, and stops nothing', () => {
  const [first] = blockers(facts({ rewritable: { key: 'branch.main.pushRemote' }, destination: null }), CHOICE);
  assert.equal(first!.kind, 'rewrite');
  assert.equal(first!.summary, "repown can't tell where the push goes");
  assert.equal(first!.lines[0], 'branch.main.pushRemote names a URL that a pushInsteadOf rule may rewrite, so repown ' +
    "can't tell where a push from main lands: the guard checks it when you push");
  assert.equal(first!.blocks, false);
});

test('a later push URL and a rewritable URL come after the owner and before divergence', () => {
  const all = facts({
    laterUrls: { remote: 'origin', owners: [{ owner: 'octo-org', host: 'GitHub' }], allowed: [] },
    rewritable: { key: 'branch.main.pushRemote' }, divergence: ok({ tracked: 'origin/main', behind: 1, ahead: 1 }),
  });
  assert.deepEqual(blockers(all, CHOICE).map((blocker) => blocker.kind), ['pushurls', 'rewrite', 'divergence']);
});

test('blockers come in a fixed order: commits, fork commits, sign-in, variables, config, owner, divergence, upstream', () => {
  const all = facts({
    unpushed: foreign(1), elsewhere: ok(theirs(2)), env: ['GH_TOKEN'], configOverrides: ['author.email'], signin: { key: 'branch.main.remote' },
    destination: { remote: 'upstream', owner: 'octo-org', allowed: [] },
    divergence: ok({ tracked: 'origin/main', behind: 1, ahead: 1 }), upstream: 'missing',
  });
  assert.deepEqual(blockers(all, CHOICE).map((blocker) => blocker.summary), [
    '1 commit by another address', '2 commits from another remote', 'the branch pushes with its own sign-in', 'GH_TOKEN is set', 'author.email is set',
    'the push goes to "octo-org"', 'main has diverged from origin/main', 'main has no upstream',
  ]);
});

test('with the guard off, what only the guard would refuse is said but blocks nothing', () => {
  const off = { ...CHOICE, guarded: false };
  const org = { remote: 'origin', owner: 'octo-org', allowed: [] };
  const found = blockers(facts({
    unpushed: foreign(2), elsewhere: ok(theirs(1)), env: ['GH_TOKEN', 'GIT_AUTHOR_EMAIL'], destination: org,
  }), off);
  const byKind = new Map(found.map((blocker) => [blocker.summary, blocker]));
  assert.equal(byKind.get('2 commits by another address')?.blocks, false);
  assert.match(byKind.get('2 commits by another address')!.lines[0]!, /; the guard is off, so they push as they are$/);
  assert.equal(byKind.get('1 commit from another remote')?.blocks, false);
  assert.match(byKind.get('1 commit from another remote')!.lines[0]!, /: the guard is off, so it pushes as it is/);
  assert.equal(byKind.get('the push goes to "octo-org"')?.blocks, false);
  assert.match(byKind.get('the push goes to "octo-org"')!.lines[0]!, /the guard is off, so it pushes there anyway/);
  assert.equal(byKind.get('GH_TOKEN is set')?.blocks, false);
  assert.equal(byKind.get('GIT_AUTHOR_EMAIL is set')?.blocks, true, 'an identity variable still changes every commit');
  assert.equal(byKind.get('GIT_AUTHOR_EMAIL is set')!.lines[0], "GIT_AUTHOR_EMAIL is set in this shell: commits made here won't use " + EMAIL + ' (unset it)');
  assert.ok(blockers(facts({ unpushed: foreign(2) }), CHOICE).every((blocker) => blocker.blocks), 'guarded: all block');
});

test('a remote named like an option gets -- before it in the push to copy, so git reads it as the remote', () => {
  const [first] = blockers(facts({ upstream: 'missing', destination: { remote: '-x', owner: 'octocat', allowed: [] } }), CHOICE);
  assert.equal(first!.lines[0], 'main has no upstream: the first push needs git push -u "--" -x main');
});
