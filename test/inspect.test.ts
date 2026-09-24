// The small judgements `repown` and `repown doctor` print. Each keeps "unknown"
// apart from "none" -- the distinction the whole tool is built on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isGcm } from '../src/core/credential/gcm.ts';
import { activeAccountLabel, storedAccountsLabel, type AuthState } from '../src/core/inspect.ts';
import { ok, err } from '../src/core/result.ts';

describe('recognising Git Credential Manager as the helper', () => {
  // Git for Windows writes `manager`; the macOS and Linux installers write a path.
  for (const helper of ['manager', 'manager-core', '/usr/local/share/gcm-core/git-credential-manager',
                        '/home/octocat/.dotnet/tools/git-credential-manager', 'C:/tools/git-credential-manager.exe']) {
    test(helper + ' is GCM', () => assert.equal(isGcm(helper), true));
  }
  for (const helper of [null, 'store', 'osxkeychain', '!gh auth git-credential', 'manager-ish-wrapper']) {
    test(String(helper) + ' is not GCM', () => assert.equal(isGcm(helper), false));
  }
});

describe('labels never collapse "unknown" into "none"', () => {
  const auth = (overrides: Partial<AuthState>): AuthState => ({
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: false, gh: ok({ accounts: [], active: null }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [], ...overrides,
  });

  test('gh active account: not installed, unknown and none are three answers', () => {
    const labels = [
      activeAccountLabel(auth({ ghPresent: false })),
      activeAccountLabel(auth({ ghPresent: true, gh: err('timed out') })),
      activeAccountLabel(auth({ ghPresent: true })),
    ];
    assert.equal(new Set(labels).size, 3, labels.join(' | '));
    assert.match(labels[1]!, /unknown/);
  });

  test('stored accounts: could not be asked is not the same as holds none', () => {
    const unknown = storedAccountsLabel(auth({ gcmPresent: true, stored: err('failed') }));
    const none = storedAccountsLabel(auth({ gcmPresent: true, stored: ok([]) }));
    assert.notEqual(unknown, none);
    assert.match(unknown, /unknown/);
  });
});
