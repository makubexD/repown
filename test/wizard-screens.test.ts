// `repown setup` as a first-time user meets it: each scenario presses real keys on the
// real @clack/prompts screens (test/setup-fixtures.ts) against a hand-built clone and
// machine, and checks what was drawn reads plainly. Nothing is written anywhere.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from '../src/core/result.ts';
import { KEY, typed, play, linesWith, setupContext } from './setup-fixtures.ts';

const { enter, up, down, esc } = KEY;
const twoAccounts = {
  octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
  'octo-work': { name: 'Octo Work', email: 'work@example.invalid', host: 'github' },
};

describe('repown setup, played with key presses', () => {
  test('S1 a clone already set up says so, and Done changes nothing', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const { outcome, screen } = await play(ctx, [[enter], [enter]]);
    assert.equal(outcome.status, 'done', screen);
    assert.match(screen, /currently pinned to octocat/);
    assert.doesNotMatch(screen, /pinned to octocat now/);
    assert.match(screen, /This clone is already set up/);
    assert.match(screen, /Nothing needs to change/);
    assert.match(screen, /Apply the same settings again/);
  });

  test('S2 a new user on an organisation repository reads every hint and a numbered review', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octo-org',
      addresses: ok(new Map([['a@example.invalid', 3], ['b@example.invalid', 1], ['c@example.invalid', 9]])),
      suggest: async () => ({ name: 'Octo Work', email: 'work@example.invalid' }),
    });
    const { outcome, screen } = await play(ctx, [[...typed('octo-work'), enter], [enter], [enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    for (const hint of ['the user name you sign in with', 'anyone who can see the repository sees it', 'a noreply address keeps yours private']) {
      const lines = linesWith(screen, hint);
      assert.ok(lines.length > 0, 'hint never shown: ' + hint + '\n' + screen);
      for (const line of lines) assert.match(line, /^│/, 'a hint drawn outside the gutter: ' + line);
    }
    assert.match(screen, /3 other people's email addresses are in this repository's commits/);
    for (const step of ['1. Record the account octo-work', '2. Let this clone push to octo-org', '3. Pin this clone to octo-work', '4. Turn on the push guard']) {
      assert.ok(screen.includes(step), 'missing review step: ' + step + '\n' + screen);
    }
    assert.match(screen, /Run these 4 steps\?/);
  });

  test('S3 gh as the credential helper is explained in plain words', async () => {
    const ctx = setupContext({ fixLines: ['  global  credential.https://github.com.helper = !gh auth git-credential'] });
    const { outcome, screen } = await play(ctx, [[enter], [enter], [up, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /gh answers git's sign-in requests with its active account only/);
    assert.match(screen, /Stop gh answering git's sign-in requests/);
  });

  test('S4 on Azure DevOps the review says who decides the push sign-in', async () => {
    const ctx = setupContext({ host: 'azdo', owner: 'octo-org', credentialPinned: false });
    const { outcome, screen } = await play(ctx, [[enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /repown pins the sign-in on GitHub only/);
    assert.doesNotMatch(screen, /not pinned by repown on this host/);
  });

  test('S5 a hook another tool owns comes with what to do about it', async () => {
    const { outcome, screen } = await play(setupContext({ guard: 'foreign' }), [[enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /another tool \(husky, for example\) owns/);
    assert.match(screen, /repown guard check/);
  });

  test('S6 a login already recorded says how to pick it', async () => {
    const { outcome, screen } = await play(setupContext(), [[down, enter], [...typed('OctoCat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.ok(screen.includes('"octocat" is already recorded on this machine: use it by that name'), screen);
    assert.doesNotMatch(screen, /type < to go back and pick it/, 'the same words serve a flag, where there is no prompt');
  });

  test('S6 a login with a space is refused with the characters allowed', async () => {
    const { outcome, screen } = await play(setupContext(), [[down, enter], [...typed('octo cat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /use letters, digits and \. _ @ - only/);
  });

  test('S7 the first question asked has no Back', async () => {
    const recorded = await play(setupContext(), [[esc]]);
    assert.doesNotMatch(recorded.screen, /← Back/);
    const fresh = await play(setupContext({ recorded: {} }), [[esc]]);
    assert.doesNotMatch(fresh.screen, /type < to go back/);
  });

  test('S8 Change an answer can return to the review', async () => {
    const ctx = setupContext({ owner: 'octo-org' });
    const { outcome, screen } = await play(ctx, [[enter], [enter], [enter], [down, down, enter], [up, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /← Back to the review/);
    assert.ok(screen.split('Review: nothing has changed yet').length > 2, 'the review is shown again\n' + screen);
  });

  test('S9 a new GitHub account without a profile gets an example address', async () => {
    const ctx = setupContext({ recorded: {}, owner: null });
    const { outcome, screen } = await play(ctx, [[...typed('octocat'), enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /Settings → Emails, like 1234\+octocat@users\.noreply\.github\.com/);
  });

  test('S10 moving a clone to another account says what changes', async () => {
    const ctx = setupContext({ pinned: 'octo-work', recorded: twoAccounts, addresses: err('git log failed') });
    const { outcome, screen } = await play(ctx, [[up, enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /This clone moves from octo-work to octocat/);
    assert.match(screen, /commits could not be read/);
  });

  test('S11 the hosts are named so a newcomer can tell them apart', async () => {
    const { outcome, screen } = await play(setupContext({ recorded: {} }), [[...typed('octocat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /another host \(GitLab, Bitbucket, self-hosted\)/);
    assert.doesNotMatch(screen, /this host/);
  });
});
