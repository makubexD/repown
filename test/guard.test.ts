// The scenario matrix. Every one of these passed against the PowerShell guard
// this replaced; the rewrite is not trusted until they pass again.
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
import { hookBody, MARKER, guardState, installGuard, uninstallGuard } from '../src/core/guard/hook.ts';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    box.git('update-ref', 'refs/remotes/upstream/master', sha);   // fetched from upstream
    // With no repown.mirrorBranch, nothing is exempt -- the safe default.
    assert.equal((await push(sha, 'refs/heads/master')).length, 1);

    box.git('config', '--local', 'repown.mirrorBranch', 'master');
    assert.deepEqual(await push(sha, 'refs/heads/master'), []);
    // ...and still refuses everywhere else.
    assert.equal((await push(sha, 'refs/heads/feat/x')).length, 1);
    box.git('config', '--local', '--unset', 'repown.mirrorBranch');
    box.git('update-ref', '-d', 'refs/remotes/upstream/master');
  });

  // The mirror carries upstream's commits, which are public already. A commit
  // made HERE and on no remote at all is not upstream's, whatever branch it is
  // pushed to -- `git push origin feature:master` must not launder it.
  test('C2 the mirror branch still refuses a foreign commit that is on no remote', async () => {
    const stray = commitAs(THEIRS, 'made here, never fetched from anywhere');
    box.git('config', '--local', 'repown.mirrorBranch', 'master');
    try {
      const refusals = await push(stray, 'refs/heads/master');
      assert.equal(refusals.length, 1);
      assert.ok(refusals[0]!.detail.some((row) => row.includes(stray.slice(0, 9))));
    } finally {
      box.git('config', '--local', '--unset', 'repown.mirrorBranch');
    }
  });

  // The commit's author chooses its subject and name. A separator byte in either
  // must not make the commit disappear from the check, or shift its fields.
  test('B2 a subject carrying a record separator cannot hide a foreign commit', async () => {
    const sha = commitAs(THEIRS, 'fix typo\x1e');
    const refusals = await push(sha, 'refs/heads/feat/x');
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.detail.some((row) => row.includes(sha.slice(0, 9))));
  });

  test('B3 a name carrying a field separator cannot shift the addresses read', async () => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const sha = box.git(
      '-c', 'user.name=x\x1f' + OURS + '\x1f' + 'y', '-c', `user.email=${THEIRS}`,
      'commit-tree', tree, '-p', box.git('rev-parse', 'HEAD'), '-m', 'spoof',
    );
    assert.equal((await push(sha, 'refs/heads/feat/x')).length, 1);
  });

  // An annotated tag carries its own `tagger` address, as permanent as an
  // author's -- and `git log <tag>` peels straight past it to the commit.
  test('B4 an annotated tag with a foreign tagger is REFUSED, even on our own commit', async () => {
    const commit = commitAs(OURS, 'ours');
    box.git('-c', `user.email=${THEIRS}`, 'tag', '-a', 'v-foreign', '-m', 'release', commit);
    const tag = box.git('rev-parse', 'v-foreign');
    const refusals = await push(tag, 'refs/tags/v-foreign');
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /tag/);
    assert.ok(refusals[0]!.detail.some((row) => row.includes(THEIRS)));
  });

  test('B5 an annotated tag we made ourselves passes', async () => {
    const commit = commitAs(OURS, 'ours');
    box.git('-c', `user.email=${OURS}`, 'tag', '-a', 'v-ours', '-m', 'release', commit);
    assert.deepEqual(await push(box.git('rev-parse', 'v-ours'), 'refs/tags/v-ours'), []);
  });

  test('B6 a foreign COMMITTER is named in the refusal, not the correct author', async () => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    const sha = box.git('-c', `user.email=${OURS}`, '-c', 'committer.name=Other', '-c', `committer.email=${THEIRS}`,
      'commit-tree', tree, '-p', box.git('rev-parse', 'HEAD'), '-m', 'rebased by someone');
    const refusals = await push(sha, 'refs/heads/feat/x');
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.detail.some((row) => row.includes(THEIRS)), 'the offending address must be shown');
  });

  test('B7 a subject cannot smuggle terminal control sequences into the refusal', async () => {
    const sha = commitAs(THEIRS, 'looks fine\x1b[2K\x1b[1AOK all good');
    const refusals = await push(sha, 'refs/heads/feat/x');
    assert.ok(refusals[0]!.detail.every((row) => !/[\x00-\x1f\x7f]/.test(row)));
  });

  test('D0 a token in the remote URL is never echoed', async () => {
    const sha = commitAs(OURS, 'ours');
    const refusals = await push(sha, 'refs/heads/feat/x', 'https://x:ghp_SECRET@github.com/someone-else/r.git');
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.detail.every((row) => !row.includes('ghp_SECRET')));
  });

  test('D1 the suggested allowOwner command quotes an owner the shell would interpret', async () => {
    const sha = commitAs(OURS, 'ours');
    const refusals = await push(sha, 'refs/heads/feat/x', 'https://github.com/x%3B%20curl%20evil/r.git');
    assert.ok(refusals[0]!.detail.some((row) => row.endsWith("repown.allowOwner 'x; curl evil'")));
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

  test('a deletion in a SHA-256 repository (64 zeros) publishes nothing either', async () => {
    const zero64 = '0'.repeat(64);
    assert.deepEqual(await check({
      git, remote: 'origin', url: ORIGIN,
      stdin: `(delete) ${zero64} refs/heads/old ${'a'.repeat(64)}\n`,
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

// The EXISTING-BRANCH path -- `remoteSha..localSha`, which is what every routine
// push takes. The matrix above never exercised it: all five scenarios push a NEW
// branch, where remoteSha is zero, and that path alone had the exclusion.
//
// The shape that exposed the gap is a fork sync. `master` fast-forwards to
// upstream and is pushed; `master` is then merged into the release branch and
// that is pushed too. The second push carries every upstream commit a second
// time, and was refused for authorship the FIRST push had published one step
// earlier -- a false positive on the most routine thing the tool does.
describe('guard check, pushing to a branch the remote already has', () => {
  let box: Sandbox;
  let git: Git;
  let base: string;

  before(() => {
    box = sandbox();
    git = new Git(box.dir);
    box.git('config', '--local', 'user.name', 'Pinned');
    box.git('config', '--local', 'user.email', OURS);
    box.git('config', '--local', 'credential.https://github.com.username', 'pinned-account');
    box.git('config', '--local', 'remote.origin.url', ORIGIN);
    box.git('commit', '--allow-empty', '-m', 'base');
    base = box.git('rev-parse', 'HEAD');
    box.git('update-ref', 'refs/remotes/origin/release', base);
  });
  after(() => box.dispose());

  /** A commit object with the given author and parents, built without moving HEAD. */
  const commitAs = (email: string, message: string, parents: readonly string[]): string => {
    const tree = box.git('rev-parse', 'HEAD^{tree}');
    return box.git(
      '-c', 'user.name=Author', '-c', `user.email=${email}`,
      'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message,
    );
  };

  /** remoteSha is a real commit here, not zero: the branch exists on the remote. */
  const pushExisting = (sha: string) => check({
    git, remote: 'origin', url: ORIGIN,
    stdin: `refs/heads/release ${sha} refs/heads/release ${base}
`,
  });

  test('a commit the remote already carries is not published again, so it is allowed', async () => {
    const upstream = commitAs(THEIRS, 'upstream work', [base]);
    box.git('update-ref', 'refs/remotes/origin/mirror', upstream);   // already pushed

    const merge = commitAs(OURS, 'Merge mirror into release', [base, upstream]);
    assert.deepEqual(await pushExisting(merge), [],
      'its address became permanent when the mirror branch was pushed, not now');
  });

  test('a foreign commit on NO remote is still refused -- scenario B must not weaken', async () => {
    const stray = commitAs(THEIRS, 'never pushed anywhere', [base]);
    const merge = commitAs(OURS, 'Merge stray into release', [base, stray]);

    const refusals = await pushExisting(merge);
    assert.equal(refusals.length, 1);
    assert.ok(refusals[0]!.detail.some((row) => row.includes(stray.slice(0, 9))),
              'the refusal must still name the unpublished commit');
  });

  // A force-push over a tip someone else pushed, without fetching first: git
  // sends that tip as remoteSha, and `remoteSha..localSha` names a commit this
  // clone does not have. `git log` fails -- and an empty answer read as "no
  // foreign commits" let the push through unchecked.
  test('a remote tip this clone never fetched does not hide a foreign commit', async () => {
    const stray = commitAs(THEIRS, 'never pushed anywhere', [base]);
    const unfetched = 'b'.repeat(40);
    const refusals = await check({
      git, remote: 'origin', url: ORIGIN,
      stdin: `refs/heads/release ${stray} refs/heads/release ${unfetched}\n`,
    });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /not authored as/);
    assert.ok(refusals[0]!.detail.some((row) => row.includes('git fetch')),
              'a wider range than usual was checked, and the refusal says how to narrow it');
  });

  test('a remote tip this clone HAS keeps the narrow range: only the new commits count', async () => {
    const earlier = commitAs(THEIRS, 'pushed long ago, tracking ref since pruned', [base]);
    const ours = commitAs(OURS, 'the only new commit', [earlier]);
    const refusals = await check({
      git, remote: 'origin', url: ORIGIN,
      stdin: `refs/heads/release ${ours} refs/heads/release ${earlier}\n`,
    });
    assert.deepEqual(refusals, [], 'the remote already has `earlier`: it says so in remoteSha');
  });

  test('commits that cannot be read are REFUSED, never passed as clean', async () => {
    const missing = 'c'.repeat(40);
    const refusals = await check({
      git, remote: 'origin', url: ORIGIN,
      stdin: `refs/heads/release ${missing} refs/heads/release ${ZERO}\n`,
    });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0]!.reason, /could not read/);
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

  test('REFUSES when repown cannot be found, rather than exiting 0', () => {
    const body = hookBody('/missing/cli.js', '/missing/node');
    assert.match(body, /exit 1/);
    assert.match(body, /Refusing rather than passing silently/);
  });

  test('single quotes in a path cannot break out of the shell literal', () => {
    const body = hookBody("/tmp/it's here/cli.js", '/usr/bin/node');
    assert.ok(body.includes("'\\''"), 'the quote must be escaped for sh');
  });
});

// Through a REAL `git push`, so the hook runs in the shell git actually uses for
// hooks (on Windows, the one bundled with Git for Windows).
describe('the installed hook, when its recorded CLI is gone', () => {
  let box: Sandbox;
  let fakeBin: string;
  const savedPath = process.env['PATH'];

  before(() => {
    box = sandbox();
    box.git('init', '-q', '--bare', join(box.dir, '..', 'remote.git'));
    box.git('remote', 'add', 'origin', join(box.dir, '..', 'remote.git'));
    box.git('commit', '-q', '--allow-empty', '-m', 'base');
    mkdirSync(join(box.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(box.dir, '.git', 'hooks', 'pre-push'),
      hookBody(join(box.dir, 'missing', 'cli.js'), join(box.dir, 'missing', 'node')), { mode: 0o755 });
    fakeBin = join(box.dir, '..', 'fake-bin');
    mkdirSync(fakeBin);
  });
  after(() => { process.env['PATH'] = savedPath; box.dispose(); });

  const pushWith = (impostor: string): ReturnType<typeof spawnSync> => {
    writeFileSync(join(fakeBin, 'repown'), impostor, { mode: 0o755 });
    return spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], {
      cwd: box.dir, encoding: 'utf8',
      env: { ...process.env, PATH: fakeBin + delimiter + (savedPath ?? '') },
    });
  };

  test('passes the remote and URL inline, so neither can ever be read as a flag', () => {
    const body = hookBody('/cli.js', '/node');
    assert.match(body, /--remote="\$1" --url="\$2"/);
  });

  test('refuses when a `repown` on PATH is not repown, even if it exits 0', () => {
    const run = pushWith('#!/bin/sh\necho "some other tool 1.0"\nexit 0\n');
    assert.notEqual(run.status, 0, 'an impostor that exits 0 must not pass the push');
    assert.match(String(run.stderr), /cannot be found/);
  });

  test('uses a `repown` on PATH that identifies itself, and honours its verdict', () => {
    const run = pushWith('#!/bin/sh\n[ "$1" = --version ] && { echo "repown 9.9.9"; exit 0; }\necho refused-by-fake >&2\nexit 1\n');
    assert.notEqual(run.status, 0);
    assert.match(String(run.stderr), /refused-by-fake/);
  });
});

// The whole path, as a user meets it: `guard on`, then a real `git push`. Every
// other real-push test uses a MISSING CLI, so a hook that ignored the check's
// verdict (`|| true`) would have passed the suite.
describe('an installed guard, end to end', () => {
  test('`guard on`, then a real push of a foreign-authored commit, is refused', async () => {
    const box = sandbox();
    try {
      const remote = join(box.dir, '..', 'remote.git');
      box.git('init', '-q', '--bare', remote);
      box.git('remote', 'add', 'origin', remote);
      box.git('config', '--local', 'user.email', OURS);
      box.git('commit', '-q', '--allow-empty', '-m', 'ours');
      box.git('-c', `user.email=${THEIRS}`, 'commit', '-q', '--allow-empty', '-m', 'theirs');
      assert.ok((await installGuard(new Git(box.dir))).ok);

      const run = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { cwd: box.dir, encoding: 'utf8' });
      assert.notEqual(run.status, 0, 'the push went through');
      assert.match(run.stderr, /not authored as/);
    } finally {
      box.dispose();
    }
  });
});

/** A hook another identity tool wrote, with the same header shape as repown's. */
const OTHER_GUARD_HOOK = '#!/bin/sh\n# other-identity-guard: installed by another tool\nexit 0\n';

describe('only a hook repown wrote is repown\'s', () => {
  let box: Sandbox;
  let git: Git;
  const hook = (): string => join(box.dir, '.git', 'hooks', 'pre-push');
  const writeHook = (body: string): void => {
    mkdirSync(join(box.dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook(), body);
  };

  beforeEach(() => { box = sandbox(); git = new Git(box.dir); });
  after(() => box?.dispose());

  test('the new hook carries the repown marker as its header and falls back to `repown`', () => {
    const body = hookBody('a', 'b');
    assert.ok(body.includes('# ' + MARKER + ':'), 'marker must be the header line');
    assert.equal(MARKER, 'repown-identity-guard');
    assert.match(body, /command -v repown /);
  });

  test('another tool\'s identity-guard hook is foreign', async () => {
    writeHook(OTHER_GUARD_HOOK);
    assert.equal(await guardState(git), 'foreign');
  });

  test('`guard on` refuses to overwrite another tool\'s identity-guard hook', async () => {
    writeHook(OTHER_GUARD_HOOK);
    assert.equal((await installGuard(git)).ok, false);
    assert.equal(readFileSync(hook(), 'utf8'), OTHER_GUARD_HOOK);
  });

  test('`guard off` refuses to delete another tool\'s identity-guard hook', async () => {
    writeHook(OTHER_GUARD_HOOK);
    assert.equal((await uninstallGuard(git)).ok, false);
    assert.equal(readFileSync(hook(), 'utf8'), OTHER_GUARD_HOOK);
  });

  // core.hooksPath (husky, git-secrets, corporate tooling) makes git run hooks
  // from another directory. A hook in .git/hooks is then never run, so reporting
  // it as 'on' is a skipped check that looks like a passed one.
  test('with core.hooksPath elsewhere, our hook in .git/hooks is not reported as on', async () => {
    writeHook(hookBody('a', 'b'));
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'elsewhere'));
    assert.equal(await guardState(git), 'off');
  });

  test('with core.hooksPath set, `guard on` refuses rather than write where git does not look', async () => {
    const shared = join(box.dir, 'shared-hooks');
    box.git('config', '--local', 'core.hooksPath', shared);
    const installed = await installGuard(git);
    assert.equal(installed.ok, false);
    assert.match(installed.ok ? '' : installed.error, /core\.hooksPath/);
    assert.equal(existsSync(hook()), false, 'nothing written to .git/hooks');
    assert.equal(existsSync(join(shared, 'pre-push')), false, 'nothing written to the shared directory');
  });

  test('with core.hooksPath set, `guard off` never deletes from the redirected directory', async () => {
    const shared = join(box.dir, 'shared-hooks');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'pre-push'), hookBody('a', 'b'));
    box.git('config', '--local', 'core.hooksPath', shared);
    assert.equal((await uninstallGuard(git)).ok, false);
    assert.equal(existsSync(join(shared, 'pre-push')), true, 'a directory repown does not own is left alone');
  });

  test('with core.hooksPath set and only another tool\'s hook there, `guard off` has nothing to do', async () => {
    const shared = join(box.dir, 'husky');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'pre-push'), OTHER_GUARD_HOOK);
    box.git('config', '--local', 'core.hooksPath', shared);
    const removed = await uninstallGuard(git);
    assert.ok(removed.ok, 'turning off a guard that was never installed is not an error');
    assert.equal(removed.value, false);
    assert.equal(readFileSync(join(shared, 'pre-push'), 'utf8'), OTHER_GUARD_HOOK);
  });

  test('with core.hooksPath set, `guard off` still removes repown\'s own leftover in .git/hooks', async () => {
    writeHook(hookBody('a', 'b'));
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'elsewhere'));
    const removed = await uninstallGuard(git);
    assert.ok(removed.ok && removed.value, 'it would come back the moment core.hooksPath is unset');
    assert.equal(existsSync(hook()), false);
  });

  test('our own hook checked out with CRLF line endings is still ours', async () => {
    writeHook(hookBody('a', 'b').replace(/\n/g, '\r\n'));
    assert.equal(await guardState(git), 'on');
  });

  test('our header pasted BELOW someone else\'s lines is theirs, not ours', async () => {
    const combined = '#!/bin/sh\n./my-own-check.sh || exit 1\n' + hookBody('a', 'b');
    writeHook(combined);
    assert.equal(await guardState(git), 'foreign');
    assert.equal((await installGuard(git)).ok, false);
    assert.equal(readFileSync(hook(), 'utf8'), combined);
  });

  test('a hook that merely MENTIONS a marker in passing stays foreign and untouched', async () => {
    const chained = '#!/bin/sh\n# runs after my own checks; see ' + MARKER + '\nexit 0\n';
    writeHook(chained);
    assert.equal(await guardState(git), 'foreign');
    assert.equal((await uninstallGuard(git)).ok, false);
    assert.equal(readFileSync(hook(), 'utf8'), chained);
  });
});

// The pinned account used to come only from the credential key -- which Azure
// DevOps, generic hosts and every SSH remote do not have. With no account the
// destination check returned nothing, silently: a push to another organisation
// passed on exactly the hosts DECISIONS §6 says it must not.
describe('guard check, the destination on hosts with no credential key', () => {
  let box: Sandbox;
  let git: Git;
  let sha: string;

  before(() => {
    box = sandbox();
    git = new Git(box.dir);
    box.git('config', '--local', 'user.name', 'Pinned');
    box.git('config', '--local', 'user.email', OURS);
    box.git('commit', '--allow-empty', '-m', 'base');
    sha = box.git('rev-parse', 'HEAD');
  });
  after(() => box.dispose());

  const pushTo = (url: string, notes: string[] = []) => check({
    git, remote: 'origin', url, onNote: (note) => notes.push(note),
    stdin: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
  });

  test('with no account pinned, the skipped destination check SAYS so', async () => {
    const notes: string[] = [];
    assert.deepEqual(await pushTo('https://dev.azure.com/other-org/p/_git/r', notes), []);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /destination not checked/);
  });

  test('repown.account makes an Azure DevOps push to another organisation REFUSED', async () => {
    box.git('config', '--local', 'repown.account', 'pinned-account');
    try {
      const refusals = await pushTo('https://dev.azure.com/other-org/p/_git/r');
      assert.equal(refusals.length, 1);
      assert.match(refusals[0]!.reason, /goes to "other-org"/);
      box.git('config', '--local', '--add', 'repown.allowOwner', 'our-org');
      assert.deepEqual(await pushTo('git@ssh.dev.azure.com:v3/our-org/p/r'), []);
    } finally {
      box.git('config', '--local', '--unset-all', 'repown.allowOwner');
      box.git('config', '--local', '--unset', 'repown.account');
    }
  });

  test('an SSH remote is compared too', async () => {
    box.git('config', '--local', 'repown.account', 'pinned-account');
    try {
      assert.equal((await pushTo('git@github.com:someone-else/repo.git')).length, 1);
      assert.deepEqual(await pushTo('git@github.com:pinned-account/repo.git'), []);
    } finally {
      box.git('config', '--local', '--unset', 'repown.account');
    }
  });

  // "Per repository, explicitly" (DECISIONS §3): a global allowOwner would
  // silently widen every clone on the machine.
  test('repown.allowOwner in GLOBAL config does not widen this clone', async () => {
    box.git('config', '--local', 'repown.account', 'pinned-account');
    box.git('config', '--global', '--add', 'repown.allowOwner', 'someone-else');
    try {
      assert.equal((await pushTo('https://github.com/someone-else/repo.git')).length, 1);
    } finally {
      box.git('config', '--global', '--unset-all', 'repown.allowOwner');
      box.git('config', '--local', '--unset', 'repown.account');
    }
  });
});

describe('pinning writes one key at a time', () => {
  // `git config` writes through a .lock file; two at once and one loses,
  // quietly. The sandbox test below cannot SEE concurrency -- a Promise.all
  // there passes most runs -- so this counts writes in flight directly.
  test('never has two config writes in flight', async () => {
    const { pinIdentity } = await import('../src/core/identity.ts');
    let inFlight = 0;
    let peak = 0;
    const counting = {
      setConfig: async (): Promise<boolean> => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return true;
      },
    } as unknown as Git;
    await pinIdentity(counting, { name: 'N', email: 'e@example.invalid', account: 'a' }, ['credential.x.username']);
    assert.equal(peak, 1);
  });
});

describe('pinning writes every key', () => {
  test('all five keys land -- they are written one at a time, never concurrently', async () => {
    const box = sandbox();
    try {
      const git = new Git(box.dir);
      const { pinIdentity, readIdentity } = await import('../src/core/identity.ts');
      const key = 'credential.https://github.com.username';

      const outcomes = await pinIdentity(
        git, { name: 'A Name', email: 'a@example.invalid', account: 'anaccount' }, [key]);

      assert.equal(outcomes.length, 5);
      assert.deepEqual(outcomes.filter((o) => !o.written), [],
        'git config writes through a .lock file; run in parallel they race and lose');

      const identity = await readIdentity(git, key);
      assert.equal(identity.name, 'A Name');
      assert.equal(identity.email, 'a@example.invalid');
      assert.equal(identity.account, 'anaccount');
      assert.equal(identity.owner, 'anaccount', 'repown.account: whose clone it is, on any host');
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
      const orgUrl = 'https://github.com/octo-org/service.git';
      const push = () => check({
        git, remote: 'origin', url: orgUrl,
        stdin: `refs/heads/work ${sha} refs/heads/work ${ZERO}\n`,
      });

      // An organisation is never an account name, so without the allow-list
      // every push to every org repository would be refused.
      const before = await push();
      assert.equal(before.length, 1);
      assert.match(before[0]!.reason, /goes to "octo-org"/);
      assert.ok(before[0]!.detail.some((d) => d.includes('repown.allowOwner')),
                'the refusal must name the way out');

      box.git('config', '--local', '--add', 'repown.allowOwner', 'octo-org');
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
