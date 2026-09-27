// What `repown use --gh` decides, before it touches a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghAction, ghCredentialAnswer, announceLogin, reportActive } from '../src/commands/use.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom, type GhState } from '../src/core/credential/gh.ts';
import { ok, err } from '../src/core/result.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';

const ASK = 'When gh asks "Authenticate Git with your GitHub credentials?", ';
const NO = ASK + 'type n and press Enter. Enter alone means Yes, and Yes makes gh answer git\'s sign-in requests for every repository.';
const YES = ASK + 'press Enter (Yes): it also stores this sign-in in ';

test('ghAction switches when gh lists the account, in any case, even if it is already active', () => {
  const listed = gh({ accounts: [{ login: 'octocat', active: true }], active: 'octocat' });
  assert.equal(ghAction('octocat', listed, true), 'switch');
  assert.equal(ghAction('OCTOCAT', listed, false), 'switch');
  const other = gh({ accounts: [{ login: 'octo-work', active: true }, { login: 'octocat', active: false }], active: 'octo-work' });
  assert.equal(ghAction('octocat', other, true), 'switch');
});

test('an account gh does not list is a login in a terminal and advice without one', () => {
  const auth = gh({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' });
  assert.equal(ghAction('octocat', auth, true), 'login');
  assert.equal(ghAction('octocat', auth, false), 'advise');
  assert.equal(ghAction('octo-org', gh({ accounts: [], active: null }), true), 'login');
});

test('a gh signed in to nobody, from the empty hosts fixture, logs in or advises', () => {
  const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const auth = gh(parsed.value);
  assert.equal(ghAction('octocat', auth, true), 'login');
  assert.equal(ghAction('octocat', auth, false), 'advise');
});

test('gh that is not installed or not queryable is left to today\'s switch', () => {
  assert.equal(ghAction('octocat', broken('gh is not installed', false), true), 'none');
  assert.equal(ghAction('octocat', broken('gh auth status failed', true), false), 'none');
});

test('the credential question names the default, or says nothing when gh is already the helper', () => {
  assert.equal(ghCredentialAnswer(base({ ghIsHelper: true, helper: '!gh auth git-credential' })), null);
  const gcm = base({ helper: 'manager', helperIsGcm: true });
  assert.equal(ghCredentialAnswer(gcm), YES + 'Git Credential Manager, so the first push won\'t ask again.');
  const other = base({ helper: 'osxkeychain' });
  assert.equal(ghCredentialAnswer(other), YES + 'osxkeychain, so the first push won\'t ask again.');
  assert.equal(ghCredentialAnswer(base()), NO);
});

test('before the browser: the clone is pinned, and Ctrl-C only skips the gh sign-in', () => {
  const none = captureErr(() => announceLogin('octocat', base()));
  assert.match(none, /This clone is already pinned\. Cancelling the browser \(Ctrl-C\) only skips the gh sign-in\./);
  assert.match(none, /type n and press Enter/);
  assert.doesNotMatch(none, /answer No/);
  const gcm = captureErr(() => announceLogin('octocat', base({ helper: 'manager', helperIsGcm: true })));
  assert.match(gcm, /press Enter \(Yes\): it also stores this sign-in in Git Credential Manager/);
  const chain = captureErr(() => announceLogin('octocat', base({ helper: 'osxkeychain' })));
  assert.match(chain, /press Enter \(Yes\): it also stores this sign-in in osxkeychain/);
  const ours = captureErr(() => announceLogin('octocat', base({ ghIsHelper: true, helper: '!gh auth git-credential' })));
  assert.match(ours, /already pinned/);
  assert.doesNotMatch(ours, /Authenticate Git/);
});

test('a login that cannot be re-read is not an account named unknown', () => {
  const unread = captureErr(() => reportActive('octocat', base({ gh: err('gh auth status failed') })));
  assert.match(unread, /WARN\s+gh\s+gh signed in, but who is active could not be read \(gh auth status failed\)/);
  assert.match(unread, /check it yourself: gh auth status/);
  assert.doesNotMatch(unread, /signed in as/);
  const other = captureErr(() => reportActive('octocat', gh({
    accounts: [{ login: 'octo-work', active: true }], active: 'octo-work',
  })));
  assert.match(other, /gh signed in as "octo-work", not octocat/);
  const nobody = captureErr(() => reportActive('octocat', gh({ accounts: [], active: null })));
  assert.match(nobody, /gh signed in, but no account is active/);
  assert.doesNotMatch(nobody, /unknown/);
  const same = captureOut(() => reportActive('Octocat', gh({
    accounts: [{ login: 'octocat', active: true }], active: 'octocat',
  })));
  assert.match(same, /signed in as Octocat, now gh's active account/);
});

function captureErr(run: () => void): string {
  return capture(process.stderr, run);
}

function captureOut(run: () => void): string {
  return capture(process.stdout, run);
}

function capture(stream: NodeJS.WriteStream, run: () => void): string {
  let text = '';
  const write = stream.write;
  stream.write = ((chunk: string | Uint8Array): boolean => { text += String(chunk); return true; }) as typeof stream.write;
  try {
    run();
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    stream.write = write;
  }
}

function gh(state: GhState, present = true): AuthState {
  return base({ ghPresent: present, gh: ok(state) });
}

function broken(error: string, present: boolean): AuthState {
  return base({ ghPresent: present, gh: err(error) });
}

function base(overrides: Partial<AuthState> = {}): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: ok({ accounts: [], active: null }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
    ...overrides,
  };
}
