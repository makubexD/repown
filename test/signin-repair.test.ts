// Which repair a failed sign-in check offers (ADR-032), and the loop that runs it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairFor, repairQuestion, triedOnce } from '../src/core/signin-repair.ts';
import { guideSignIn, UNHELPED, type GuideIo, type GuidedCheck } from '../src/commands/signin-guide.ts';
import type { SignInContext } from '../src/core/signin-check.ts';

const CTX: SignInContext = { remote: 'origin', host: 'github.com', account: 'octo-work', fromUrl: false, pinned: 'octo-work', helper: 'manager', github: true };
const GH = '!/usr/bin/gh auth git-credential';

describe('repairFor', () => {
  test('a rejected or missing sign-in through GCM on github.com: GCM\'s login, as the account git sends', () => {
    assert.deepEqual(repairFor({ kind: 'rejected' }, CTX), { kind: 'login', account: 'octo-work' });
    assert.deepEqual(repairFor({ kind: 'no-sign-in' }, CTX), { kind: 'login', account: 'octo-work' });
  });

  test('gh as the helper: repown fix first', () => {
    assert.deepEqual(repairFor({ kind: 'rejected' }, { ...CTX, helper: GH }), { kind: 'fix' });
  });

  test('a username from the URL is never signed in as: that URL is the blocker to remove', () => {
    assert.equal(repairFor({ kind: 'rejected' }, { ...CTX, fromUrl: true }), null);
  });

  test('nothing measured to run: another helper, another host, no account named', () => {
    assert.equal(repairFor({ kind: 'rejected' }, { ...CTX, helper: 'store' }), null);
    assert.equal(repairFor({ kind: 'rejected' }, { ...CTX, github: false }), null);
    assert.equal(repairFor({ kind: 'no-sign-in' }, { ...CTX, account: null }), null);
  });

  test('SSO waits for the user, with or without a link', () => {
    assert.deepEqual(repairFor({ kind: 'sso', link: 'https://github.com/x/sso' }, CTX), { kind: 'sso', link: 'https://github.com/x/sso' });
    assert.deepEqual(repairFor({ kind: 'sso', link: null }, CTX), { kind: 'sso', link: null });
  });

  test('denied as another account: pin the recorded one again, only where that changes the username git sends', () => {
    const sendsOther = { ...CTX, account: 'octocat' };
    assert.deepEqual(repairFor({ kind: 'denied', as: 'octocat' }, sendsOther), { kind: 'use', account: 'octo-work' });
    assert.equal(repairFor({ kind: 'denied', as: 'octocat' }, { ...sendsOther, fromUrl: true }), null);
    assert.equal(repairFor({ kind: 'denied', as: 'octocat' }, { ...CTX, account: null, helper: null }), null, 'SSH: the key decides');
    assert.deepEqual(repairFor({ kind: 'denied', as: 'octocat' }, CTX), { kind: 'login', account: 'octo-work' }, 'already sent: the stored token is someone else\'s');
    assert.equal(repairFor({ kind: 'deploy-key' }, CTX), null);
    assert.equal(repairFor({ kind: 'denied', as: 'Octo-Work' }, CTX), null, 'the pinned account itself needs write access');
  });

  test('nothing for a verdict no repair changes', () => {
    for (const kind of ['not-found', 'ssh-key', 'host-key'] as const) assert.equal(repairFor({ kind }, CTX), null);
    assert.equal(repairFor({ kind: 'unchecked', reason: 'timed out' }, CTX), null);
  });

  test('each question names what runs', () => {
    assert.match(repairQuestion({ kind: 'login', account: 'octo-work' }) ?? '', /Sign in to GitHub as octo-work now\?/);
    assert.equal(repairQuestion({ kind: 'fix' }), null, 'fix previews its entries, then asks its own question');
    assert.equal(triedOnce({ kind: 'sso', link: null }), null);
  });
});

describe('guideSignIn', () => {
  /** A check that answers each call from the list, and records the prompts and actions. */
  function scripted(checks: GuidedCheck[], answers: { confirm?: boolean[]; enter?: boolean[]; ran?: boolean } = {}) {
    const log: string[] = [];
    let calls = 0;
    const check = async (): Promise<GuidedCheck> => checks[Math.min(calls++, checks.length - 1)]!;
    const io: GuideIo = {
      confirm: async (question) => { log.push('ask: ' + question); return answers.confirm?.shift() ?? true; },
      waitEnter: async () => { log.push('wait'); return answers.enter?.shift() ?? true; },
      say: (line) => { log.push('say: ' + line); },
      run: async (repair) => { log.push('run: ' + repair.kind); return answers.ran ?? true; },
    };
    return { check, io, log, calls: () => calls };
  }
  const pass: GuidedCheck = { level: 'pass', remote: 'origin', repair: null };
  const login: GuidedCheck = { level: 'fail', remote: 'origin', repair: { kind: 'login', account: 'octo-work' } };
  const sso: GuidedCheck = { level: 'fail', remote: 'origin', repair: { kind: 'sso', link: null } };

  test('a pass asks nothing', async () => {
    const s = scripted([pass]);
    assert.equal((await guideSignIn(s.check, s.io)).level, 'pass');
    assert.deepEqual(s.log, []);
  });

  test('a yes runs the repair, then checks again until it passes', async () => {
    const s = scripted([login, pass]);
    assert.equal((await guideSignIn(s.check, s.io)).level, 'pass');
    assert.deepEqual(s.log, ['ask: ' + repairQuestion({ kind: 'login', account: 'octo-work' }), 'run: login']);
    assert.equal(s.calls(), 2);
  });

  test('a no stops with the failure, and runs nothing', async () => {
    const s = scripted([login], { confirm: [false] });
    assert.equal((await guideSignIn(s.check, s.io)).level, 'fail');
    assert.deepEqual(s.log, ['ask: ' + repairQuestion({ kind: 'login', account: 'octo-work' })]);
  });

  test('the same repair is offered once: a second failure after it says so and stops the loop', async () => {
    const s = scripted([login, login]);
    assert.equal((await guideSignIn(s.check, s.io)).level, 'fail');
    assert.equal(s.log.filter((line) => line.startsWith('run')).length, 1);
    assert.equal(s.log.at(-1), 'say: ' + UNHELPED);
  });

  test('a repair that did not run stops without checking again', async () => {
    const s = scripted([login, pass], { ran: false });
    assert.equal((await guideSignIn(s.check, s.io)).level, 'fail');
    assert.equal(s.calls(), 1);
  });

  test('SSO waits for Enter and checks again, as often as the user asks, until q', async () => {
    const s = scripted([sso, sso, sso, pass], { enter: [true, true, false] });
    assert.equal((await guideSignIn(s.check, s.io)).level, 'fail');
    assert.deepEqual(s.log, ['wait', 'wait', 'wait']);
    const done = scripted([sso, sso, pass]);
    assert.equal((await guideSignIn(done.check, done.io)).level, 'pass');
  });

  test('one repair can lead to another: gh undone (fix asks its own question), then GCM\'s login', async () => {
    const fix: GuidedCheck = { level: 'fail', remote: 'origin', repair: { kind: 'fix' } };
    const s = scripted([fix, login, pass]);
    assert.equal((await guideSignIn(s.check, s.io)).level, 'pass');
    assert.deepEqual(s.log, ['run: fix', 'ask: ' + repairQuestion({ kind: 'login', account: 'octo-work' }), 'run: login']);
  });

  test('the result says a repair ran, so the caller does not repeat what it read before', async () => {
    const s = scripted([login, pass]);
    assert.equal((await guideSignIn(s.check, s.io)).repaired, true);
    const waited = scripted([sso, pass]);
    assert.equal((await guideSignIn(waited.check, waited.io)).repaired, undefined, 'an SSO wait changes nothing here');
  });
});

describe('gcmGithubLogin', () => {
  test('hands the terminal to GCM\'s measured github.com sign-in, and reads only its exit code', async () => {
    const { gcmGithubLogin } = await import('../src/core/credential/gcm.ts');
    const seen: string[][] = [];
    const runner = async (file: string, args: readonly string[]) => { seen.push([file, ...args]); return { code: 0, stdout: '', stderr: '' }; };
    assert.equal(await gcmGithubLogin('octo-work', runner), true);
    assert.deepEqual(seen, [['git', 'credential-manager', 'github', 'login', '--username', 'octo-work', '--browser', '--force']]);
    assert.equal(await gcmGithubLogin('octo-work', async () => ({ code: 1, stdout: '', stderr: '' })), false);
  });
});
