// What `repown use --gh` decides, before it touches a process; and what `use` says
// about unpushed commits by another address (the real entry point, spawned).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghAction, ghCredentialAnswer, announceLogin, reportActive } from '../src/commands/use.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom, type GhState } from '../src/core/credential/gh.ts';
import { ok, err } from '../src/core/result.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
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

// S19. Foreign commits are built with commit-tree, as the guard tests do, then
// pointed at with update-ref so they are actually on the branch `use` reads.
const OURS = 'octocat@example.invalid';
const THEIRS = 'other@example.invalid';
const AMEND = '--exec "git commit --amend --no-edit --reset-author --allow-empty"';

/** `one`: a single address made them all, so pinning it is offered too. */
function reauthor(which: 'it' | 'them', base: string, one = true): string {
  return 're-author ' + which + ': git rebase ' + base + ' ' + AMEND + (one ? ', or pin that address' : '');
}

describe('repown use warns about unpushed commits by another address (S19)', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('a commit no remote has, by another author, warns and still exits 0', async () => {
    commitAs(box, OURS, 'ours');
    const sha = commitAs(box, THEIRS, 'theirs');
    box.git('config', 'log.showSignature', 'true');
    box.git('config', 'gpg.program', 'repown-gpg-should-not-run');
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(box.git('rev-parse', 'HEAD'), sha, 'use must not rewrite the commit');
    assert.equal(box.git('log', '-1', '--format=%ae'), THEIRS);
    assert.match(run.stderr, new RegExp('WARN\\s+commits\\s+1 commit on main not on any remote is by ' + THEIRS + '; the guard will refuse it'));
    assert.match(run.stderr, new RegExp(escapeRe(reauthor('it', box.git('rev-parse', '--short', 'HEAD^')))));
    assert.doesNotMatch(run.stdout, /not on any remote/);
    assert.doesNotMatch(run.stderr, /could not be read/);
  });

  test('the rebase starts after your own commits: at the parent of the oldest foreign one', async () => {
    commitAs(box, OURS, 'ours, root');
    const lastOwn = commitAs(box, OURS, 'ours, second');
    commitAs(box, THEIRS, 'theirs');
    commitAs(box, OURS, 'ours again');
    commitAs(box, THEIRS, 'theirs again');
    const run = await runUse(box);
    assert.match(run.stderr, /2 commits on main not on any remote are by other@example\.invalid/);
    assert.match(run.stderr, new RegExp(escapeRe(reauthor('them', box.git('rev-parse', '--short', lastOwn)))));
  });

  test('a foreign committer is named even when the author is the pinned address', async () => {
    commitAs(box, OURS, 'ours');
    commitAs(box, OURS, 'rebased', THEIRS);
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, new RegExp('1 commit on main not on any remote is by ' + THEIRS));
    assert.doesNotMatch(run.stderr, /is by octocat@example\.invalid/);
  });

  test('author and committer addresses are both listed, once each, ignoring case', async () => {
    commitAs(box, OURS, 'ours');
    commitAs(box, 'A@example.invalid', 'both', 'b@example.invalid');
    commitAs(box, 'a@example.invalid', 'again', 'a@example.invalid');
    const run = await runUse(box);
    assert.match(run.stderr, /2 commits on main not on any remote are by a@example\.invalid, b@example\.invalid; the guard will refuse them/);
    assert.match(run.stderr, new RegExp(escapeRe(reauthor('them', box.git('rev-parse', '--short', 'HEAD~2'), false)) + '$', 'm'));
  });

  test('an address that only differs by case from the pin is not foreign', async () => {
    commitAs(box, 'Octocat@example.invalid', 'same person');
    const run = await runUse(box);
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.stderr, /not on any remote/);
  });

  test('lists three addresses, then and N more', async () => {
    commitAs(box, OURS, 'ours');
    for (const address of ['a@example.invalid', 'b@example.invalid', 'c@example.invalid', 'd@example.invalid']) {
      commitAs(box, address, address);
    }
    const run = await runUse(box);
    assert.match(run.stderr, /4 commits on main not on any remote are by d@example\.invalid, c@example\.invalid, b@example\.invalid and 1 more/);
    assert.doesNotMatch(run.stderr, /a@example\.invalid/);
  });

  test('a commit a remote-tracking ref already has is not named', async () => {
    commitAs(box, THEIRS, 'published');
    box.git('update-ref', 'refs/remotes/origin/main', box.git('rev-parse', 'HEAD'));
    const quiet = await runUse(box);
    assert.equal(quiet.code, 0);
    assert.doesNotMatch(quiet.stderr, /not on any remote/);
    commitAs(box, THEIRS, 'local only');
    const base = box.git('rev-parse', '--short', 'HEAD^');
    const run = await runUse(box);
    assert.match(run.stderr, /1 commit on main not on any remote is by other@example\.invalid/);
    assert.match(run.stderr, new RegExp(escapeRe(reauthor('it', base))));
  });

  test('a detached HEAD is skipped', async () => {
    commitAs(box, THEIRS, 'on main');
    box.git('checkout', '--detach');
    const run = await runUse(box);
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.stderr, /not on any remote|could not be read/);
  });

  test('a commit on another branch, not reachable from HEAD, is not named', async () => {
    commitAs(box, OURS, 'ours');
    const side = commitObject(box, 'side@example.invalid', 'side only');
    box.git('branch', 'side', side);
    const run = await runUse(box);
    assert.equal(run.code, 0);
    assert.doesNotMatch(run.stderr, /side@example\.invalid|not on any remote/);
  });

  test('a clone with no commits yet says nothing, rather than claiming the log failed', async () => {
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /not on any remote|could not be read/);
  });

  test('a log that cannot be read is a warning, not a passed check', async () => {
    commitAs(box, THEIRS, 'theirs');
    const dir = join(box.dir, '.git', 'refs', 'remotes', 'origin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'main'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /WARN\s+commits\s+commits on main not on any remote could not be read \(/);
    assert.match(run.stderr, /so repown can't say whether the guard will refuse them/);
    assert.doesNotMatch(run.stderr, /are by|re-author/);
  });
});

// Where this branch pushes, when no remote-tracking ref says what it already has: HEAD
// --not --remotes then counts commits that may be published, and a rebase from that base
// would rewrite them. Nothing offline tells an empty remote from an unfetched one, so the
// rebase is offered only for the case where it is right (ADR-025).
describe('repown use when the branch pushes where no tracking ref reaches (ADR-025)', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const RECOUNT = 'then repown use octocat to count again';
  const GUARD = ' (the guard skips any already on the branch you push to)';
  const UNKNOWN = 'origin has no remote-tracking refs, so some of these may already be on it' + GUARD + ': git fetch origin, ' + RECOUNT;

  test('a remote never fetched: fetch first, and the rebase only if it has none of them', async () => {
    const published = publishedThenLocal(box);
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /2 commits on main not on any remote are by other@example\.invalid/);
    assert.match(run.stderr, new RegExp(escapeRe(UNKNOWN)));
    assert.match(run.stderr, new RegExp(escapeRe('if origin has none of them, ' + reauthor('them', '--root'))));
    assert.doesNotMatch(run.stderr, /^\s+re-author/m);
    box.git('fetch', '-q', 'origin');
    const fetched = await runUse(box);
    assert.match(fetched.stderr, /1 commit on main not on any remote is by other@example\.invalid/);
    assert.match(fetched.stderr, new RegExp('^\\s+' + escapeRe(reauthor('it', box.git('rev-parse', '--short', published))), 'm'));
    assert.doesNotMatch(fetched.stderr, /remote-tracking|has none of them/);
  });

  test('a fetch that failed changes nothing', async () => {
    publishedThenLocal(box);
    rmSync(remoteDir(box), { recursive: true, force: true });
    assert.throws(() => box.git('fetch', '-q', 'origin'));
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe(UNKNOWN)));
    assert.doesNotMatch(run.stderr, /^\s+re-author/m);
  });

  test('a branch whose remote is a URL is pointed at the remote with that URL, which is not printed', async () => {
    publishedThenLocal(box);
    box.git('config', 'remote.origin.url', 'https://github.com/octocat/hello.git');
    box.git('config', 'branch.main.remote', 'https://octocat:secret-token@github.com/octocat/hello');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe(
      'this branch pushes to a URL, not a remote, so some of these may already be there' + GUARD + ': ' +
      'git config --local branch.main.remote origin, git fetch origin, ' + RECOUNT)));
    assert.match(run.stderr, new RegExp(escapeRe('if it has none of them, ' + reauthor('them', '--root'))));
    assert.doesNotMatch(run.stderr, /secret-token|octocat\/hello/);
  });

  test('the push remote decides, not origin', async () => {
    publishedThenLocal(box);
    box.git('fetch', '-q', 'origin');
    box.git('remote', 'add', 'fork', remoteDir(box));
    box.git('config', 'branch.main.pushRemote', 'fork');
    const run = await runUse(box);
    assert.match(run.stderr, /fork has no remote-tracking refs, so some of these may already be on it/);
    assert.match(run.stderr, /if fork has none of them, re-author it: git rebase /);
  });

  test('an empty remote stays unknown after a fetch; the rebase it needs is still offered', async () => {
    box.git('init', '-q', '--bare', remoteDir(box));
    box.git('remote', 'add', 'origin', remoteDir(box));
    box.git('fetch', '-q', 'origin');
    commitAs(box, THEIRS, 'first');
    commitAs(box, THEIRS, 'second');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe('if origin has none of them, ' + reauthor('them', '--root'))));
  });

  test('a remote that pushes to another URL than it fetches from is unknown, however fetched', async () => {
    publishedThenLocal(box);
    box.git('fetch', '-q', 'origin');
    box.git('config', 'remote.origin.pushurl', 'https://github.com/octocat/fork.git');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe('origin pushes to another URL than it fetches from, so some of these may already be there' + GUARD)));
    assert.match(run.stderr, /if origin has none of them, re-author it: git rebase /);
    assert.doesNotMatch(run.stderr, /octocat\/fork/);
  });

  test('a branch remote that names no configured remote says so, not "a URL"', async () => {
    publishedThenLocal(box);
    box.git('config', 'branch.main.remote', 'orign');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe('this branch pushes to "orign", which is not a remote here, so some of these may already be there' + GUARD)));
    assert.doesNotMatch(run.stderr, /a URL/);
  });

  // #6: a clone that fetches only some branches gets no tracking ref when another branch is
  // pushed, so HEAD --not --remotes counts what that push already published.
  const SKIPPED = (branch: string): string =>
    'origin\'s ' + branch + ' is not fetched here (remote.origin.fetch leaves it out), so some of these may already be there' + GUARD;

  test('a single-branch clone: a pushed feature branch is not tracked, so the rebase is conditional', async () => {
    publishedThenLocal(box);
    box.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    box.git('fetch', '-q', 'origin');
    box.git('switch', '-q', '-c', 'feature');
    box.git('push', '-q', 'origin', 'feature');
    commitAs(box, THEIRS, 'after the push');
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, new RegExp(escapeRe(SKIPPED('feature'))));
    assert.match(run.stderr, /if origin has none of them, re-author them: git rebase /);
    assert.doesNotMatch(run.stderr, /^\s+re-author/m);
  });

  test('an ordinary clone, a branch never pushed: no new warning, the rebase as before', async () => {
    const published = publishedThenLocal(box);
    box.git('fetch', '-q', 'origin');
    box.git('switch', '-q', '-c', 'feature');
    commitAs(box, THEIRS, 'feature work');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp('^\\s+' + escapeRe(reauthor('them', box.git('rev-parse', '--short', published))), 'm'));
    assert.doesNotMatch(run.stderr, /not fetched here|remote-tracking|has none of them/);
  });

  test('a negative refspec that leaves the branch out counts as not fetched', async () => {
    publishedThenLocal(box);
    box.git('fetch', '-q', 'origin');
    box.git('switch', '-q', '-c', 'feature');
    box.git('config', '--add', 'remote.origin.fetch', '^refs/heads/feature');
    commitAs(box, THEIRS, 'feature work');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe(SKIPPED('feature'))));
  });

  test('push.default=upstream: the upstream branch decides, and it is named', async () => {
    publishedThenLocal(box);
    box.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    box.git('fetch', '-q', 'origin');
    box.git('switch', '-q', '-c', 'feature');
    box.git('config', 'push.default', 'upstream');
    box.git('config', 'branch.feature.remote', 'origin');
    box.git('config', 'branch.feature.merge', 'refs/heads/main');
    commitAs(box, THEIRS, 'feature work');
    const quiet = await runUse(box);
    assert.doesNotMatch(quiet.stderr, /not fetched here|has none of them/);
    box.git('config', 'branch.feature.merge', 'refs/heads/trunk');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe(SKIPPED('trunk'))));
  });

  test('tracking refs are read where the remote\'s own refspec writes them (#12c)', async () => {
    publishedThenLocal(box);
    box.git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/mirror/*');
    box.git('fetch', '-q', 'origin');
    const run = await runUse(box);
    assert.doesNotMatch(run.stderr, /remote-tracking|has none of them/);
  });

  test('another remote named origin/x does not make origin look fetched (#12c)', async () => {
    publishedThenLocal(box);
    // `git remote add` refuses this name now; older git and hand-written config do not.
    box.git('config', 'remote.origin/x.url', remoteDir(box));
    box.git('config', 'remote.origin/x.fetch', '+refs/heads/*:refs/remotes/origin/x/*');
    box.git('fetch', '-q', 'origin/x');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp(escapeRe(UNKNOWN)));
  });

  test('one remote not named origin, and nothing configured: git push has no destination, so the advice is unchanged', async () => {
    publishedThenLocal(box);
    box.git('remote', 'rename', 'origin', 'up');
    const run = await runUse(box);
    assert.match(run.stderr, new RegExp('^\\s+' + escapeRe(reauthor('them', '--root')), 'm'));
    assert.doesNotMatch(run.stderr, /remote-tracking|has none of them/);
  });
});

function remoteDir(box: Sandbox): string {
  return join(box.dir, '..', 'remote.git');
}

/** One commit pushed to a bare `origin` by path, so no tracking ref records it; then one local. */
function publishedThenLocal(box: Sandbox): string {
  const published = commitAs(box, THEIRS, 'published');
  box.git('init', '-q', '--bare', remoteDir(box));
  box.git('push', '-q', remoteDir(box), 'HEAD:refs/heads/main');
  box.git('remote', 'add', 'origin', remoteDir(box));
  commitAs(box, THEIRS, 'local only');
  return published;
}

/** First commit is an empty one (there is no tree yet); the rest are commit-tree, then on HEAD. */
function commitAs(box: Sandbox, author: string, message: string, committer = author): string {
  return dated(() => {
    if (!hasHead(box)) {
      box.git(
        '-c', 'user.name=Author', '-c', `user.email=${author}`,
        '-c', 'committer.name=Author', '-c', `committer.email=${committer}`,
        'commit', '--allow-empty', '-m', message,
      );
      return box.git('rev-parse', 'HEAD');
    }
    const sha = commitObject(box, author, message, committer);
    box.git('update-ref', 'HEAD', sha);
    return sha;
  });
}

/** Newer commits get a later committer date, so `git log` order does not depend on the clock. */
let stamp = 1_700_000_000;

function dated(run: () => string): string {
  const saved = { author: process.env['GIT_AUTHOR_DATE'], committer: process.env['GIT_COMMITTER_DATE'] };
  const date = String(stamp);
  stamp += 60;
  process.env['GIT_AUTHOR_DATE'] = date;
  process.env['GIT_COMMITTER_DATE'] = date;
  try {
    return run();
  } finally {
    restoreDate('GIT_AUTHOR_DATE', saved.author);
    restoreDate('GIT_COMMITTER_DATE', saved.committer);
  }
}

function restoreDate(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function hasHead(box: Sandbox): boolean {
  try {
    box.git('rev-parse', '--verify', '--quiet', 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/** commit-tree does not move HEAD. The caller decides whether the branch points here. */
function commitObject(box: Sandbox, author: string, message: string, committer = author): string {
  const tree = box.git('rev-parse', 'HEAD^{tree}');
  const parent = box.git('rev-parse', '--verify', 'HEAD');
  return box.git(
    '-c', 'user.name=Author', '-c', `user.email=${author}`,
    '-c', 'committer.name=Author', '-c', `committer.email=${committer}`,
    'commit-tree', tree, '-p', parent, '-m', message,
  );
}

// The real entry point, in its own process: replacing process.stdout.write here
// would also swallow the test runner's own report, hiding every other result.
async function runUse(box: Sandbox): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = ['--cwd', box.dir, '--name', 'Octo Cat', '--email', OURS, 'octocat'];
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined };
  const run = spawnSync(process.execPath, [CLI, 'use', ...args], { input: '', env, encoding: 'utf8' });
  return { code: run.status ?? -1, stdout: stripAnsi(run.stdout), stderr: stripAnsi(run.stderr) };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('repown use says nothing about a credential pin where it sets none (#2)', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
    box.writeGlobalConfig('[credential]\n\thelper = !gh auth git-credential\n');
  });
  afterEach(() => box.dispose());

  const GH_HELPER = /gh is still the git credential helper, so this pin is not honoured/;

  test('a GitHub clone over HTTPS still hears that gh is the helper', async () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    const run = await runUse(box);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, GH_HELPER);
  });

  for (const url of ['https://dev.azure.com/octocat/project/_git/repo', 'git@github.com:octocat/project.git', 'https://git.example.invalid/octocat/project.git']) {
    test('a clone whose pushes use their host\'s own sign-in hears nothing about the pin: ' + url, async () => {
      box.git('remote', 'add', 'origin', url);
      const run = await runUse(box);
      assert.equal(run.code, 0, run.stderr);
      assert.doesNotMatch(run.stderr, GH_HELPER);
      assert.doesNotMatch(run.stdout + run.stderr, /No stored credential|repown fix/);
    });
  }
});
