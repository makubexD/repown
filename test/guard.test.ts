// The scenario matrix. Every one of these passed against the PowerShell guard
// this replaces; the rewrite is not trusted until they pass again.
//
// Commits are made with `git commit-tree`, which writes a commit object WITHOUT
// moving HEAD or touching the working tree. That is what makes it safe to build
// a foreign-authored commit and hand it to the guard: nothing about the checkout
// changes, so a failing test cannot leave a repository in a state anyone has to
// clean up.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { check, parsePushRefs } from '../src/core/guard/check.ts';
import { hookBody, MARKER } from '../src/core/guard/hook.ts';

const ZERO = '0'.repeat(40);
const OURS = 'pinned@example.invalid';
const THEIRS = 'someone-else@example.invalid';
const ORIGIN = 'https://github.com/pinned-account/project.git';

describe('guard check', () => {
  let box: Sandbox;
  let git: Git;

  before(() => {
    box = sandbox();
    git = new Git(box.dir);
    box.git('config', '--local', 'user.name', 'Pinned');
    box.git('config', '--local', 'user.email', OURS);
    box.git('config', '--local', 'credential.https://github.com.username', 'pinned-account');
    box.git('config', '--local', 'remote.origin.url', ORIGIN);
    box.git('commit', '--allow-empty', '-m', 'base');
  });
  after(() => box.dispose());

  beforeEach(() => {
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
      delete process.env[name];
    }
  });

  /** A commit object with the given author, built without moving HEAD. */
  const commitAs = (email: string, message: string): string => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const parent = box.git('rev-parse', 'HEAD');
    return box.git(
      '-c', `user.name=Author`, '-c', `user.email=${email}`,
      '-c', `committer.name=Author`,
      'commit-tree', tree, '-p', parent, '-m', message,
    );
  };

  const push = (sha: string, remoteRef: string, url = ORIGIN) => check({
    git,
    remote: 'origin',
    url,
    stdin: `refs/heads/work ${sha} ${remoteRef} ${ZERO}\n`,
  });

  test('A  own commits to a feature branch are allowed', async () => {
    const sha = commitAs(OURS, 'ours');
    assert.deepEqual(await push(sha, 'refs/heads/feat/x'), []);
  });

  test('B  a foreign author to a feature branch is REFUSED, and the commit is named', async () => {
    const sha = commitAs(THEIRS, 'theirs');
    const refusals = await push(sha, 'refs/heads/feat/x');

    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /not authored as/);
    assert.ok(refusals[0]!.detail.some((row) => row.includes(sha.slice(0, 9))),
              'the refusal must name the offending commit');
  });

  test('C  the mirror exemption applies ONLY to the configured branch', async () => {
    const sha = commitAs(THEIRS, 'upstream work');
    // With no gid.mirrorBranch, nothing is exempt -- the safe default.
    assert.equal((await push(sha, 'refs/heads/master')).length, 1);

    box.git('config', '--local', 'gid.mirrorBranch', 'master');
    assert.deepEqual(await push(sha, 'refs/heads/master'), []);
    // ...and still refuses everywhere else.
    assert.equal((await push(sha, 'refs/heads/feat/x')).length, 1);
    box.git('config', '--local', '--unset', 'gid.mirrorBranch');
  });

  test('D  a push to someone else’s repository is REFUSED', async () => {
    const sha = commitAs(OURS, 'ours');
    const refusals = await push(sha, 'refs/heads/feat/x',
                                'https://github.com/someone-else/project.git');
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /goes to "someone-else"/);
  });

  test('D2 the pinned account in the USERINFO does not make a push look like ours', async () => {
    // The previous guard substring-matched the whole remote string, so this
    // exact shape passed while pushing to a different owner entirely.
    const sha = commitAs(OURS, 'ours');
    const refusals = await push(sha, 'refs/heads/feat/x',
                                'https://pinned-account@github.com/someone-else/project.git');
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /goes to "someone-else"/);
  });

  test('E  a hostile environment variable is REFUSED before anything else is checked', async () => {
    const sha = commitAs(OURS, 'ours');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
      process.env[name] = 'x';
      const refusals = await push(sha, 'refs/heads/feat/x');
      assert.equal(refusals.length, 1, name + ' must be refused');
      assert.match(refusals[0]!.reason, new RegExp(name));
      delete process.env[name];
    }
  });

  test('a branch DELETION publishes nothing, so it is allowed', async () => {
    assert.deepEqual(await check({
      git, remote: 'origin', url: ORIGIN,
      stdin: `(delete) ${ZERO} refs/heads/old ${ZERO}\n`,
    }), []);
  });

  test('an unpinned clone REFUSES rather than guessing what is foreign', async () => {
    const bare = sandbox();
    try {
      bare.git('commit', '--allow-empty', '-m', 'x');
      bare.git('config', '--local', '--unset', 'user.email');
      const refusals = await check({
        git: new Git(bare.dir), remote: 'origin', url: ORIGIN,
        stdin: `refs/heads/work ${bare.git('rev-parse', 'HEAD')} refs/heads/work ${ZERO}\n`,
      });
      assert.equal(refusals.length, 1);
      assert.match(refusals[0]!.reason, /sets no identity of its own/);
    } finally {
      bare.dispose();
    }
  });
});

describe('push ref parsing', () => {
  test('reads the four fields git sends on stdin', () => {
    const refs = parsePushRefs('refs/heads/a 1111 refs/heads/b 2222\n\nrefs/heads/c 3333 refs/heads/d 4444\n');
    assert.equal(refs.length, 2);
    assert.deepEqual(refs[0], {
      localRef: 'refs/heads/a', localSha: '1111', remoteRef: 'refs/heads/b', remoteSha: '2222',
    });
  });

  test('blank and malformed lines are ignored, not crashed on', () => {
    assert.deepEqual(parsePushRefs('\n   \ngarbage\n'), []);
  });
});

describe('hook body', () => {
  test('is LF-only -- sh rejects a CRLF script with "bad interpreter"', () => {
    const body = hookBody('/path/to/cli.js', '/usr/bin/node');
    assert.ok(!body.includes('\r'), 'the hook must contain no carriage returns');
  });

  test('carries its marker, so the tool can recognise its own hook', () => {
    assert.ok(hookBody('a', 'b').includes(MARKER));
  });

  test('REFUSES when gid cannot be found, rather than exiting 0', () => {
    const body = hookBody('/missing/cli.js', '/missing/node');
    assert.match(body, /exit 1/);
    assert.match(body, /Refusing rather than passing silently/);
  });

  test('single quotes in a path cannot break out of the shell literal', () => {
    const body = hookBody("/tmp/it's here/cli.js", '/usr/bin/node');
    assert.ok(body.includes("'\\''"), 'the quote must be escaped for sh');
  });
});

describe('pinning writes every key', () => {
  test('all four keys land -- they are written one at a time, never concurrently', async () => {
    const box = sandbox();
    try {
      const git = new Git(box.dir);
      const { pinIdentity, readIdentity } = await import('../src/core/identity.ts');
      const key = 'credential.https://github.com.username';

      const outcomes = await pinIdentity(
        git, { name: 'A Name', email: 'a@example.invalid', account: 'anaccount' }, [key]);

      assert.equal(outcomes.length, 4);
      assert.deepEqual(outcomes.filter((o) => !o.written), [],
        'git config writes through a .lock file; run in parallel they race and lose');

      const identity = await readIdentity(git, key);
      assert.equal(identity.name, 'A Name');
      assert.equal(identity.email, 'a@example.invalid');
      assert.equal(identity.account, 'anaccount');
      assert.equal(identity.useConfigOnly, 'true');
    } finally {
      box.dispose();
    }
  });
});

describe('organisation repositories', () => {
  test('an org owner is refused by default, and allowed once listed', async () => {
    const box = sandbox();
    try {
      const git = new Git(box.dir);
      box.git('config', '--local', 'user.name', 'Dev');
      box.git('config', '--local', 'user.email', OURS);
      box.git('config', '--local', 'credential.https://github.com.username', 'a-person');
      box.git('commit', '--allow-empty', '-m', 'base');
      const sha = box.git('rev-parse', 'HEAD');
      const orgUrl = 'https://github.com/An-Org/service.git';
      const push = () => check({
        git, remote: 'origin', url: orgUrl,
        stdin: `refs/heads/work ${sha} refs/heads/work ${ZERO}\n`,
      });

      // An organisation is never an account name, so without the allow-list
      // every push to every org repository would be refused.
      const before = await push();
      assert.equal(before.length, 1);
      assert.match(before[0]!.reason, /goes to "An-Org"/);
      assert.ok(before[0]!.detail.some((d) => d.includes('gid.allowOwner')),
                'the refusal must name the way out');

      box.git('config', '--local', '--add', 'gid.allowOwner', 'An-Org');
      assert.deepEqual(await push(), [], 'a listed owner is legitimate');

      // ...and listing one owner does not open the door to any other.
      const elsewhere = await check({
        git, remote: 'origin', url: 'https://github.com/Other-Org/service.git',
        stdin: `refs/heads/work ${sha} refs/heads/work ${ZERO}\n`,
      });
      assert.equal(elsewhere.length, 1);
    } finally {
      box.dispose();
    }
  });
});
