// What `repown use --gh` decides, before it touches a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghAction, ghCredentialAnswer } from '../src/commands/use.ts';
import type { AuthState } from '../src/core/inspect.ts';
import type { GhState } from '../src/core/credential/gh.ts';
import { ok, err } from '../src/core/result.ts';

const NO = 'answer No: Yes would make gh answer git\'s sign-in requests for every repository, and repown would then need `repown fix`';
const YES = 'Yes also stores this sign-in in ';

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

test('gh that is not installed or not queryable is left to today\'s switch', () => {
  assert.equal(ghAction('octocat', broken('gh is not installed', false), true), 'none');
  assert.equal(ghAction('octocat', broken('gh auth status failed', true), false), 'none');
});

test('the credential question: nothing, store in the helper, or answer No', () => {
  assert.equal(ghCredentialAnswer(base({ ghIsHelper: true, helper: '!gh auth git-credential' })), null);
  const gcm = base({ helper: 'manager', helperIsGcm: true });
  assert.equal(ghCredentialAnswer(gcm), YES + 'Git Credential Manager, so the first push won\'t ask again');
  const other = base({ helper: 'osxkeychain' });
  assert.equal(ghCredentialAnswer(other), YES + 'osxkeychain, so the first push won\'t ask again');
  assert.equal(ghCredentialAnswer(base()), NO);
});

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
