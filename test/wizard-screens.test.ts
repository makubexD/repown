// `repown setup` as a first-time user meets it: each scenario presses real keys on the
// real @clack/prompts screens (test/setup-fixtures.ts) against a hand-built clone and
// machine, and checks what was drawn reads plainly. Nothing is written anywhere.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ok, err } from '../src/core/result.ts';
import { KEY, typed, play, linesWith, setupContext } from './setup-fixtures.ts';
import { wizard } from '../src/wizard/engine.ts';
import { plainPrompter } from '../src/wizard/plain.ts';
import { setupFlow, type SetupContext } from '../src/wizard/setup-flow.ts';
import { textWidth, wrap } from '../src/wizard/review-text.ts';

const { enter, up, down, esc } = KEY;
const twoAccounts = {
  octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
  'octo-work': { name: 'Octo Work', email: 'work@example.invalid', host: 'github' },
};

describe('repown setup, played with key presses', () => {
  test('S1 a settled clone opens on that screen, and Done changes nothing', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const { outcome, screen } = await play(ctx, [[enter]]);
    assert.equal(outcome.status, 'done', screen);
    assert.doesNotMatch(screen, /How should setup work/);
    assert.doesNotMatch(screen, /Which account should this clone belong to/);
    assert.doesNotMatch(screen, /Sign in to gh/);
    assert.match(screen, /This clone is already set up/);
    assert.match(screen, /Nothing needs to change/);
    assert.match(screen, /upstream {4}set on the first push \(push\.autoSetupRemote\)/);
    assert.match(screen, /Done \(change nothing\)/);
    assert.match(screen, /Use another account/);
    assert.doesNotMatch(screen, /Apply the same settings again/);
    assert.doesNotMatch(screen, /Change an answer/);
    assert.match(screen.replace(/│/g, ' ').replace(/\s+/g, ' '), /See it any time: repown status \(this clone\), repown doctor \(this machine\)/);
  });

  test('a settled clone whose branch tracks origin shows that ref', async () => {
    const ctx = setupContext({
      pinned: 'octocat', guard: 'on', pinIntact: true,
      upstream: { supported: true, enabled: true, branch: 'main', tracked: 'origin/main' },
    });
    const { outcome, screen } = await play(ctx, [[esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /upstream {4}origin\/main/);
    assert.doesNotMatch(screen, /set on the first push/);
  });

  test('Use another account opens the account question, and Back returns', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const { outcome, screen } = await play(ctx, [[down, enter], [down, down, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.equal(screen.split('This clone is already set up').length - 1, 2, screen);
    assert.match(screen, /Use another account \(choose a different account for this clone\)/);
    assert.match(screen, /Which account should this clone belong to/);
    assert.doesNotMatch(screen, /How should setup work/);
    assert.match(screen, /← Back/);
  });

  test('Sign in to gh, when gh acts as someone else, reviews that one step', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = setupContext({ gh, pinned: 'octocat', guard: 'on', pinIntact: true });
    const { outcome, screen } = await play(ctx, [[down, down, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const plain = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.match(plain, /Sign in to gh as octocat/);
    assert.match(plain, /If you use gh here, choose "Sign in to gh as octocat" below\./);
    assert.doesNotMatch(screen, /later: repown use|--gh {3}\(/);
    assert.doesNotMatch(screen, /Sign in to gh as octocat too\?/);
    assert.doesNotMatch(screen.split('Run this step?')[0] ?? '', /How should setup work|Which account/);
    assert.match(plain, /1\. Pin this clone to octocat, and sign octocat in to gh \(opens your browser\)/);
    assert.match(plain, /repown use octocat --gh/);
    assert.doesNotMatch(plain, /2\./);
    assert.match(plain, /Run this step\?/);
  });

  test('Recommended on a pinned intact clone with auto-upstream unset lists only that step', async () => {
    const ctx = setupContext({
      pinned: 'octocat', guard: 'on', pinIntact: true,
      upstream: { supported: true, enabled: null, branch: 'main', tracked: null },
      stored: ok([]),
    });
    const { outcome, screen } = await play(ctx, [[enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const plain = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(screen, /This clone is already set up/);
    assert.match(plain, /1\. Push branches without -u: the first push sets the upstream \(this clone only\)/);
    assert.match(plain, /git config --local push\.autoSetupRemote true/);
    assert.doesNotMatch(screen, /Pin this clone/);
    assert.doesNotMatch(plain, /2\./);
    assert.match(plain, /No stored credential for octocat yet: the first push signs in once \(your browser opens\)/);
  });

  test('Recommended does not ask gh when the clone is already pinned to that account', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const ctx = setupContext({ gh, pinned: 'octocat', pinIntact: true, guard: 'off' });
    const recommended = await play(ctx, [[enter], [enter], [esc]]);
    assert.equal(recommended.outcome.status, 'cancelled', recommended.screen);
    assert.doesNotMatch(recommended.screen, /Sign in to gh as octocat too\?/);
    assert.doesNotMatch(recommended.screen, /Also make this account gh's active account\?/);
    const plain = recommended.screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.equal(plain.split('If you use gh here:').length - 1, 1, recommended.screen);
    assert.match(plain, /If you use gh here: repown use octocat --gh \(signs octocat in to gh\)\./);
    assert.doesNotMatch(recommended.screen, /later: repown use|--gh {3}\(/);
    const stepped = await play(ctx, [[down, enter], [enter], [esc]]);
    assert.match(stepped.screen, /Sign in to gh as octocat too\?/);
  });

  test('S2 a new user on an organisation repository reads every hint and a numbered review', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octo-org',
      addresses: ok(new Map([['a@example.invalid', 3], ['b@example.invalid', 1], ['c@example.invalid', 9]])),
      suggest: async () => ({ name: 'Octo Work', email: 'work@example.invalid' }),
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [...typed('octo-work'), enter], [enter], [enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    for (const hint of ['the name you sign in with', 'anyone who can see the repository sees it', 'anyone who can see the repository can read it']) {
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

  test('G1 an account gh does not know is offered a sign-in', async () => {
    const gh = ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
    const { outcome, screen } = await play(setupContext({ gh }), [[down, enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const plain = screen.replace(/\n│\s*/g, ' ');
    assert.match(plain, /Sign in to gh as octocat too\?/);
    assert.match(plain, /gh is GitHub's command-line tool \(gh pr create\); git pushes don't need it\. Yes opens your browser to sign in, and gh then acts as octocat in every terminal/);
    assert.match(plain, /gh's active account is octo-work/);
  });

  test('S3 gh as the credential helper is explained in plain words', async () => {
    const ctx = setupContext({ fixLines: ['  global  credential.https://github.com.helper = !gh auth git-credential'] });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [up, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /gh answers git's sign-in requests with its active account only/);
    assert.match(screen, /Stop gh answering git's sign-in requests/);
  });

  test('S4 on Azure DevOps the review says who decides the push sign-in', async () => {
    const ctx = setupContext({ host: 'azdo', owner: 'octo-org', credentialPinned: false });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /repown pins the sign-in on GitHub only/);
    assert.doesNotMatch(screen, /not pinned by repown on this host/);
  });

  test('S5 a hook another tool owns comes with what to do about it', async () => {
    const { outcome, screen } = await play(setupContext({ guard: 'foreign' }), [[down, enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /another tool \(husky, for example\) owns/);
    assert.match(screen, /repown guard check/);
  });

  test('S6 a login already recorded says how to pick it', async () => {
    const { outcome, screen } = await play(setupContext(), [[down, enter], [down, enter], [...typed('OctoCat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.ok(screen.includes('"octocat" is already recorded on this machine: use it by that name'), screen);
    assert.doesNotMatch(screen, /type < to go back and pick it/, 'the same words serve a flag, where there is no prompt');
  });

  test('S6 a login with a space is refused with the characters allowed', async () => {
    const { outcome, screen } = await play(setupContext(), [[down, enter], [down, enter], [...typed('octo cat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /use letters, digits and \. _ @ - only/);
  });

  test('S7 the first question asked has no Back', async () => {
    const recorded = await play(setupContext(), [[esc]]);
    assert.match(recorded.screen, /How should setup work\?/);
    assert.doesNotMatch(recorded.screen, /← Back/);
    const fresh = await play(setupContext({ recorded: {} }), [[esc]]);
    assert.match(fresh.screen, /How should setup work\?/);
    assert.doesNotMatch(fresh.screen, /type < to go back/);
  });

  test('Recommended asks how setup should work, the account, and a foreign owner, then the review lists the rest', async () => {
    const gh = ok({
      accounts: [{ login: 'octocat', active: false }, { login: 'octo-work', active: true }],
      active: 'octo-work',
    });
    const ctx = setupContext({
      gh, owner: 'octo-org', guard: 'off',
      upstream: { supported: true, enabled: null, branch: 'main', tracked: null },
    });
    const { outcome, screen } = await play(ctx, [[down], [up, enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const opening = screen.split('Which account should this clone belong to?')[0] ?? '';
    assert.match(opening, /How should setup work\?/);
    assert.doesNotMatch(opening, /← Back/);
    assert.ok(marked(opening, 'Recommended'), opening);
    const plain = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.match(plain, /asks only what it must, fills in the rest, and shows every step before running/);
    assert.match(plain, /asks every question, and explains each change before making it/);
    assert.match(plain, /This repository belongs to "octo-org"\. Let this clone push to it\?/);
    assert.doesNotMatch(screen, /Turn on the push guard\?/);
    assert.doesNotMatch(screen, /Push branches without -u\?/);
    assert.doesNotMatch(screen, /Also make this account gh's active account\?/);
    assert.match(screen, /Let this clone push to octo-org's repositories/);
    assert.match(screen, /make it gh's active account/);
    assert.match(screen, /Turn on the push guard: each push is checked first/);
    assert.match(screen.replace(/│/g, ' ').replace(/\s+/g, ' '), /Push branches without -u: the first push sets the upstream \(this clone only\)/);
    assert.match(screen, /git config --local push\.autoSetupRemote true/);
  });

  test('S8 Change an answer can return to the review', async () => {
    const ctx = setupContext({ owner: 'octo-org' });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [enter], [down, down, enter], [up, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /← Back to the review/);
    assert.ok(screen.split('Review: nothing has changed yet').length > 2, 'the review is shown again\n' + screen);
  });

  test('S9 a new GitHub account without a profile gets an example address', async () => {
    const ctx = setupContext({ recorded: {}, owner: null });
    const { outcome, screen } = await play(ctx, [[down, enter], [...typed('octocat'), enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen.replace(/\n│  /g, ' '), /github\.com\/settings\/emails, like 1234\+octocat@users\.noreply\.github\.com/);
  });

  test('S10 moving a clone to another account says what changes', async () => {
    const ctx = setupContext({ pinned: 'octo-work', recorded: twoAccounts, addresses: err('git log failed') });
    const { outcome, screen } = await play(ctx, [[down, enter], [up, enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /This clone moves from octo-work to octocat/);
    assert.match(screen, /commits could not be read/);
  });

  test('S11 the hosts are named so a newcomer can tell them apart', async () => {
    const { outcome, screen } = await play(setupContext({ recorded: {} }), [[down, enter], [...typed('octocat'), enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /another host \(GitLab, Bitbucket, self-hosted\)/);
    assert.doesNotMatch(screen, /this host/);
  });

  test('S12 in a narrow window every line fits, and hints stay in the gutter', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const keys = [[down, enter], [down, enter], [...typed('octo-work'), enter], [enter], [enter], [...typed('octo-work@example.invalid'), enter], [down, enter], [esc]];
    const { outcome, screen } = await play(ctx, keys, { columns: 60 });
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /This clone moves from octocat to octo-work/);
    // A text answer is redrawn at each key press, with a cursor (█) the window never keeps.
    const wide = screen.split('\n').filter((line) => line.length > 60 && !line.includes('█'));
    assert.deepEqual(wide, [], 'lines wider than the window:\n' + wide.join('\n'));
    // Each hint line as setup wrapped it: clack wraps a question again if it's too wide.
    const hint = setupFlow(ctx).steps.find((step) => step.id === 'allowOwner')!.hint;
    if (typeof hint !== 'string') throw new Error('allowOwner hint');
    for (const line of wrap(hint, textWidth(60, 13))) assert.ok(screen.includes('│  ' + line + '\n'), 'hint line rewrapped: ' + line + '\n' + screen);
  });

  test('S13 Back says where it goes, since ↑ from the first choice lands on it', async () => {
    const { outcome, screen } = await play(setupContext(), [[down, enter], [enter], [up], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /← Back \(to the previous question\)/);
  });

  test('D1 nothing recorded, and the owner is a user: that owner is listed and preselected', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octocat', ownerIsUser: true, detected: detectedPair,
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const first = screen.slice(0, screen.indexOf('Where is this account hosted?'));
    assert.match(first, /right now this clone isn't pinned to any account/);
    assert.ok(marked(first, 'octocat'), first);
    assert.ok(!marked(first, 'octo-work'), first);
    assert.ok(!marked(first, 'a new account'), first);
    const ownerAt = first.indexOf('octocat (owns this repository)');
    const workAt = first.indexOf('octo-work');
    const freshAt = first.indexOf('a new account');
    assert.ok(ownerAt >= 0 && workAt > ownerAt && freshAt > workAt, first);
    assert.match(screen, /Your name, as your commits show it/);
    assert.doesNotMatch(screen, /The account's user name/);
    assert.match(screen, /Record the account octocat/);
    assert.match(screen, /repown accounts add octocat/);
    assert.match(screen, /repown use octocat/);
    assert.doesNotMatch(screen, /repown (?:accounts add|use) \+/);
    assert.doesNotMatch(screen, /(?:Record the account|Pin this clone to) \+octocat/);
  });

  test('D2 an organisation owner is left out, and a gh account is not preselected', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octo-org', ownerIsUser: false,
      detected: [{ login: 'octo-work', from: ['signed in to gh'] }],
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /octo-work/);
    assert.doesNotMatch(screen, /octo-org/);
    assert.ok(marked(screen, 'a new account'), screen);
    assert.ok(!marked(screen, 'octo-work'), screen);
  });

  test('D3 an owner of unknown kind may be an organisation, and is not preselected', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octocat', ownerIsUser: null,
      detected: [{ login: 'octocat', from: ['owns this repository'] }],
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [up], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const account = screen.slice(screen.indexOf('Which account should this clone belong to?'));
    const opened = account.split('↑/↓ to navigate')[0] ?? '';
    assert.ok(marked(opened, 'a new account'), opened);
    assert.ok(!marked(opened, 'octocat'), opened);
    assert.match(screen, /octocat \(owns this repository; may be an organisation\)/);
  });

  test('D9 Back from the next question keeps the detected account selected', async () => {
    const ctx = setupContext({ recorded: {}, owner: 'octocat', ownerIsUser: true, detected: detectedPair });
    const { outcome, screen } = await play(ctx, [[down, enter], [down, enter], [up, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const restored = screen.split('Where is this account hosted?').at(-1) ?? '';
    assert.ok(marked(restored, 'octo-work'), restored);
    assert.ok(!marked(restored, 'octocat'), restored);
  });

  test('D7 a new account shows the machine default, and the typed value stays the profile suggestion', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octocat', ownerIsUser: true,
      detected: [{ login: 'octocat', from: ['owns this repository'] }],
      machineIdentity: { name: 'Octo Work', email: 'octo-work@example.invalid' },
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const flat = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.match(flat, /not this machine's default name \(Octo Work\), unless this account uses it/);
    assert.match(flat, /not this machine's default address \(octo-work@example\.invalid\), unless this account uses it/);
    assert.doesNotMatch(flat, /type it|Octo Work </);
    assert.match(screen, /Octo Cat█/);
    assert.match(screen, /octocat@example\.invalid█/);
    assert.doesNotMatch(screen, /Octo Work█/);
    assert.doesNotMatch(screen, /octo-work@example\.invalid█/);
  });

  test('S16 step by step shows what each step changes, then Yes / Skip / Stop', async () => {
    const ctx = setupContext({
      owner: 'octo-org',
      hookPath: '/work/project/.git/hooks/pre-push',
      upstream: { supported: true, enabled: null, branch: 'main', tracked: null },
    });
    // Step by step, accept the account and the three clone questions, Run, Yes, Yes, then Stop.
    const keys = [[down, enter], [enter], [enter], [enter], [enter], [enter], [enter], [enter], [down, down, enter]];
    const { outcome, screen } = await play(ctx, keys);
    assert.equal(outcome.status, 'run', screen);
    const plain = screen.replace(/\n│\s*/g, ' ');
    assert.match(plain, /repown\.allowOwner \+= octo-org/);
    assert.match(plain, /Let this clone push to octo-org's repositories/);
    assert.match(plain, /> git config --local --add repown\.allowOwner octo-org/);
    assert.match(plain, /user\.name = Octo Cat/);
    assert.match(plain, /user\.email = octocat@example\.invalid/);
    assert.match(plain, /user\.useConfigOnly = true/);
    assert.match(plain, /repown\.account = octocat/);
    assert.match(plain, /credential\.https:\/\/github\.com\.username = octocat/);
    assert.match(plain, /Pin this clone to octocat: its commit name, email and push sign-in/);
    assert.match(plain, /> repown use octocat/);
    assert.match(plain, /pre-push hook: \/work\/project\/\.git\/hooks\/pre-push runs repown guard check/);
    assert.match(screen, /Run this step\?/);
    assert.match(screen, /Yes/);
    assert.match(screen, /Skip/);
    assert.match(screen, /Stop/);
    assert.doesNotMatch(plain, /push\.autoSetupRemote = true/);
  });

  test('pushing a branch without an upstream is one question, default Yes, and a review step', async () => {
    const ctx = setupContext({ upstream: { supported: true, enabled: null, branch: 'main', tracked: null } });
    const { outcome, screen } = await play(ctx, [[down, enter], [enter], [enter], [enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const plain = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.ok(screen.indexOf('Turn on the push guard?') < screen.indexOf('Push branches without -u?'), screen);
    assert.match(plain, /Push branches without -u\?/);
    assert.match(plain, /sets push\.autoSetupRemote in this clone only, so the first push of a branch without an upstream creates it on origin; the guard still checks it/);
    assert.match(plain, /Push branches without -u: the first push sets the upstream \(this clone only\)/);
    assert.match(plain, /git config --local push\.autoSetupRemote true/);
  });

  test('old git skips that question and the settled screen names git push -u', async () => {
    const ctx = setupContext({
      pinned: 'octocat', guard: 'on', pinIntact: true,
      upstream: { supported: false, enabled: null, branch: 'main', tracked: null },
    });
    const { outcome, screen } = await play(ctx, [[esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /This clone is already set up/);
    assert.doesNotMatch(screen, /How should setup work|Push branches without -u/);
    const plain = screen.replace(/│/g, ' ').replace(/\s+/g, ' ');
    assert.match(plain, /the first push of a branch without an upstream needs: git push -u origin main/);
    assert.doesNotMatch(plain, /upstream {4}set on the first push \(push\.autoSetupRemote\)/);
  });

  test('D11 a recorded owner is preselected over the account recorded first', async () => {
    const ctx = setupContext({
      recorded: {
        'octo-work': { name: 'Octo Work', email: 'octo-work@example.invalid', host: 'github' },
        octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
      },
      owner: 'octocat',
    });
    const { outcome, screen } = await play(ctx, [[down, enter], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.ok(marked(screen, 'octocat'), screen);
    assert.ok(!marked(screen, 'octo-work'), screen);
  });
});

describe('D7 on the plain prompter, at the default width', () => {
  test('the machine address is a warning, and no wrapped line tells you to type it', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octocat', ownerIsUser: true,
      detected: [{ login: 'octocat', from: ['owns this repository'] }],
      machineIdentity: { name: 'Octo Work', email: 'octo-work@example.invalid' },
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const screen = await playPlain(ctx, '\n\n\n\n\n');
    const flat = screen.replace(/\s+/g, ' ');
    assert.match(flat, /not this machine's default name \(Octo Work\), unless this account uses it/);
    assert.match(flat, /not this machine's default address \(octo-work@example\.invalid\)/);
    for (const line of screen.split('\n')) {
      assert.doesNotMatch(line, /(?:Octo Work|octo-work@example\.invalid)\)?\s+type it\s*$/);
    }
  });
});

/** Columns unset: the plain prompter wraps as it does in an 80-column window. */
async function playPlain(ctx: SetupContext, lines: string): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk: Buffer) => { screen += chunk.toString(); });
  input.write(lines);
  input.end();
  const prompter = plainPrompter({ input, output });
  try {
    await wizard(setupFlow(ctx), ctx, {}, prompter);
  } finally {
    prompter.close();
  }
  return screen;
}

const detectedPair = [
  { login: 'octocat', from: ['owns this repository'] },
  { login: 'octo-work', from: ['signed in to gh', 'stored in Git Credential Manager'] },
];

/** The active radio: clack's disc, or `>` where the terminal has no unicode. */
function marked(screen: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:\u25cf|>) ' + escaped).test(screen);
}
