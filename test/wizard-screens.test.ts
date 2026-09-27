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
  test('S1 a clone already set up says so, and Done changes nothing', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const { outcome, screen } = await play(ctx, [[enter], [enter]]);
    assert.equal(outcome.status, 'done', screen);
    assert.match(screen, /right now this clone is pinned to octocat/);
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
    assert.match(screen.replace(/\n│  /g, ' '), /github\.com\/settings\/emails, like 1234\+octocat@users\.noreply\.github\.com/);
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

  test('S12 in a narrow window every line fits, and hints stay in the gutter', async () => {
    const ctx = setupContext({ pinned: 'octocat', guard: 'on', pinIntact: true });
    const keys = [[down, enter], [...typed('octo-work'), enter], [enter], [enter], [...typed('octo-work@example.invalid'), enter], [down, enter], [esc]];
    const { outcome, screen } = await play(ctx, keys, { columns: 60 });
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /This clone moves from octocat to octo-work/);
    // A text answer is redrawn at each key press, with a cursor (█) the window never keeps.
    const wide = screen.split('\n').filter((line) => line.length > 60 && !line.includes('█'));
    assert.deepEqual(wide, [], 'lines wider than the window:\n' + wide.join('\n'));
    // Each hint line as setup wrapped it: clack wraps a question again if it's too wide.
    const hint = setupFlow(ctx).steps.find((step) => step.id === 'allowOwner')!.hint;
    for (const line of wrap(hint, textWidth(60, 13))) assert.ok(screen.includes('│  ' + line + '\n'), 'hint line rewrapped: ' + line + '\n' + screen);
  });

  test('S13 Back says where it goes, since ↑ from the first choice lands on it', async () => {
    const { outcome, screen } = await play(setupContext(), [[enter], [up], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    assert.match(screen, /← Back \(to the previous question\)/);
  });

  test('D1 nothing recorded, and the owner is a user: that owner is listed and preselected', async () => {
    const ctx = setupContext({
      recorded: {}, owner: 'octocat', ownerIsUser: true, detected: detectedPair,
      suggest: async () => ({ name: 'Octo Cat', email: 'octocat@example.invalid' }),
    });
    const { outcome, screen } = await play(ctx, [[enter], [enter], [enter], [enter], [enter], [esc]]);
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
    const { outcome, screen } = await play(ctx, [[esc]]);
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
    const { outcome, screen } = await play(ctx, [[up], [esc]]);
    assert.equal(outcome.status, 'cancelled', screen);
    const opened = screen.split('↑/↓ to navigate')[0] ?? '';
    assert.ok(marked(opened, 'a new account'), opened);
    assert.ok(!marked(opened, 'octocat'), opened);
    assert.match(screen, /octocat \(owns this repository; may be an organisation\)/);
  });

  test('D9 Back from the next question keeps the detected account selected', async () => {
    const ctx = setupContext({ recorded: {}, owner: 'octocat', ownerIsUser: true, detected: detectedPair });
    const { outcome, screen } = await play(ctx, [[down, enter], [up, enter], [esc]]);
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
    const { outcome, screen } = await play(ctx, [[enter], [enter], [enter], [esc]]);
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

  test('D11 a recorded owner is preselected over the account recorded first', async () => {
    const ctx = setupContext({
      recorded: {
        'octo-work': { name: 'Octo Work', email: 'octo-work@example.invalid', host: 'github' },
        octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' },
      },
      owner: 'octocat',
    });
    const { outcome, screen } = await play(ctx, [[esc]]);
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
    const screen = await playPlain(ctx, '\n\n\n\n');
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
