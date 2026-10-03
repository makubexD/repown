// The small judgements `repown` and `repown doctor` print. Each keeps "unknown"
// apart from "none" -- the distinction the whole tool is built on.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isGcm } from '../src/core/credential/gcm.ts';
import { activeAccountLabel, inspectRepo, storedAccountsLabel, type AuthState } from '../src/core/inspect.ts';
import { Git } from '../src/core/git.ts';
import { sandbox } from './helpers.ts';
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

describe('the owner a clone pushes to', () => {
  test('is read from the URL git pushes to, after insteadOf and pushInsteadOf, as the guard reads it', async () => {
    const box = sandbox();
    try {
      box.git('remote', 'add', 'origin', 'https://github.com/octocat/hello.git');
      assert.equal((await inspectRepo(new Git(box.dir))).owner, 'octocat');
      box.git('config', 'url.https://github.com/octo-org/.pushInsteadOf', 'https://github.com/octocat/');
      const repo = await inspectRepo(new Git(box.dir));
      assert.equal(repo.owner, 'octo-org', 'pushes go to octo-org');
      assert.equal(repo.originUrl, 'https://github.com/octocat/hello.git', 'the configured URL still drives the credential probes');
    } finally {
      box.dispose();
    }
  });
});

describe('the owner and the host it is on', () => {
  test('come from the same push URL, even when fetch and push are on different hosts', async () => {
    const box = sandbox();
    try {
      box.git('remote', 'add', 'origin', 'https://github.com/octo-org/hello.git');
      box.git('config', 'remote.origin.pushurl', 'https://git.example.invalid/octocat/hello.git');
      const repo = await inspectRepo(new Git(box.dir));
      assert.equal(repo.owner, 'octocat');
      assert.equal(repo.ownerProvider.id, 'generic', 'the push host, not the GitHub fetch host');
      assert.equal(repo.provider.id, 'github', 'credentials still follow the fetch URL');
    } finally {
      box.dispose();
    }
  });

  test('a remote whose name reads like an option is still read as a name', async () => {
    const box = sandbox();
    try {
      box.git('config', 'remote.-h.url', 'https://github.com/octo-org/hello.git');
      assert.equal(await new Git(box.dir).remotePushUrl('-h'), 'https://github.com/octo-org/hello.git');
    } finally {
      box.dispose();
    }
  });
});
