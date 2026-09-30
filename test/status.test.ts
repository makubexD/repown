// `repown status` says where the clone is and which settings are its own.
// S6 title, path and branch; S7 the two groups; S8 the recorded account;
// S9 what to run next; S10 outside a repository.
// The upstream field and the ready: summary (ADR-020).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { ghAdvice } from '../src/commands/status.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { loadRegistry, registryPath } from '../src/core/registry.ts';
import { err, ok } from '../src/core/result.ts';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { compileFakeExe } from './fake-exe.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TITLE = 'repown status · current settings of this clone';
plainTerminal();

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string; }

function repown(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input: '', env, encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('repown status layout', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S6: the title is on stdout', () => {
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, new RegExp('^' + TITLE + '$', 'm'));
    assert.doesNotMatch(run.stderr, /repown status ·/);
    assert.equal(repown([], box.dir).stdout, run.stdout);
  });

  // sandbox() is `git init -b main` with no commit: the branch exists, HEAD does not.
  // Git prints the work tree with forward slashes. Status shows native separators on Windows.
  test('S6: path and branch, including an unborn branch', () => {
    const root = box.git('rev-parse', '--show-toplevel');
    const shown = shownPath(root);
    const run = repown(['status'], box.dir);
    const title = run.stdout.indexOf(TITLE);
    const where = run.stdout.indexOf('  ' + shown + '  (branch main)');
    const clone = run.stdout.indexOf('This clone');
    assert.ok(title >= 0 && where > title && clone > where, run.stdout);
    if (process.platform === 'win32') assert.equal(shown.includes('\\'), true);
  });

  test('S6: a detached HEAD shows its short hash', () => {
    box.git('commit', '--allow-empty', '-m', 'base');
    box.git('checkout', '--detach');
    const hash = box.git('rev-parse', '--short', 'HEAD');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, new RegExp('\\(detached at ' + hash + '\\)'));
    assert.doesNotMatch(run.stdout, /\(branch /);
  });

  test('S7: This clone, then This machine, with their fields', () => {
    const run = repown(['status'], box.dir);
    assert.ok(run.stdout.indexOf('This clone') < run.stdout.indexOf('This machine'));
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'push guard']);
    assert.deepEqual(fieldsUnder(run.stdout, 'This machine'),
      ['default', 'helper', 'gh active']);
  });

  test('S7: existing values keep their wording', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /pushes as\s+octocat$/m);
    assert.match(run.stdout, /origin\s+octocat {2}\(GitHub\)/);
    assert.match(run.stdout, /push guard\s+off$/m);
    assert.match(run.stdout, /helper\s+manager$/m);
  });

  test('S7: default is the effective identity an unpinned clone inherits', () => {
    unpin(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Cat\n\temail = octocat@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /commits as\s+NOT SET LOCALLY/);
    assert.match(run.stdout, /default\s+Octo Cat <octocat@example\.invalid>/);
  });

  test('S7: an includeIf address is the default, and the FAIL quotes that same address', () => {
    unpin(box);
    const included = join(box.dir, '..', 'included-identity');
    writeFileSync(included, '[user]\n\temail = octo-work@example.invalid\n');
    box.writeGlobalConfig('[includeIf "gitdir:**"]\n\tpath = ' + included.replaceAll('\\', '/') + '\n');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /default\s+\? <octo-work@example\.invalid>/);
    assert.match(run.stderr, /inherits the machine default \(octo-work@example\.invalid\)/);
  });

  test('S7: a pinned clone shows an identity that lives only in the system file', () => {
    pinGithub(box);
    const system = process.env['GIT_CONFIG_SYSTEM'];
    assert.ok(system);
    writeFileSync(system, '[user]\n\tname = Octo Work\n\temail = octo-work@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /default\s+Octo Work <octo-work@example\.invalid>/);
  });

  test('S7: default stays the machine identity when this clone pins another', () => {
    pinGithub(box);
    box.writeGlobalConfig('[user]\n\tname = Octo Work\n\temail = octo-work@example.invalid\n');
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /commits as\s+Octo Cat <octocat@example\.invalid>/);
    assert.match(run.stdout, /default\s+Octo Work <octo-work@example\.invalid>/);
  });

  test('S7: default is none when neither name nor email is set', () => {
    unpin(box);
    const run = repown(['status'], box.dir);
    assert.match(run.stdout, /^ {2}default\s+none$/m);
  });
});

describe('repown status upstream', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S1: no upstream prints the push -u form, after origin, not as a warning', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'upstream', 'push guard']);
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.doesNotMatch(run.stderr, /upstream|none yet|push -u/);
  });

  test('S1: with no origin, the push -u form uses the first remote', () => {
    box.git('remote', 'add', 'work', 'https://github.com/octocat/project.git');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u work main'));
  });

  test('S1: origin wins over another remote in the push -u form', () => {
    box.git('remote', 'add', 'work', 'https://github.com/octocat/other.git');
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
  });

  test('S2: a tracked branch shows the ref git reports', () => {
    pinGithub(box);
    guardOn(box);
    track(box, 'origin/develop');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'origin/develop'));
  });

  test('S3: autoSetupRemote true locally, no upstream', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'true');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: autoSetupRemote true in global config, no upstream', () => {
    pinGithub(box);
    guardOn(box);
    box.writeGlobalConfig('[push]\n\tautoSetupRemote = true\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: a truthy non-true value still counts (push.autoSetupRemote)', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'yes');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'set on the first push (push.autoSetupRemote)'));
  });

  test('S3: autoSetupRemote false still shows the push -u form', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'push.autoSetupRemote', 'false');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(upstreamLine(run.stdout), fieldLine('upstream', 'none yet: git push -u origin main'));
  });

  test('S4: a detached HEAD has no upstream field, even with a remote', () => {
    pinGithub(box);
    box.git('commit', '--allow-empty', '-m', 'base');
    box.git('checkout', '--detach');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stdout, /\(detached at /);
    assert.equal(upstreamLine(run.stdout), undefined);
  });

  test('S4: no remote means no upstream field', () => {
    const run = repown(['status'], box.dir, quietEnv());
    assert.deepEqual(fieldsUnder(run.stdout, 'This clone'),
      ['commits as', 'pushes as', 'account', 'origin', 'push guard']);
    assert.equal(upstreamLine(run.stdout), undefined);
  });
});

describe('repown status ready line', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S5: no problems, gh active as another account is a note after the identity line', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /OK {4}identity {3}this clone is pinned, and its credential mechanism honours it/);
    assert.ok(run.stderr.includes(GH_ACTIVE_NOTE), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown use octocat --gh   (signs octocat in to gh)'), run.stderr);
    assert.doesNotMatch(run.stderr, /WARN {2}gh/);
    assert.doesNotMatch(run.stdout, /NOTE {2}gh/);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 0, run.stderr);
    assert.ok(run.stderr.indexOf('NOTE  gh') < run.stderr.indexOf('ready:'), run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · gh: optional (see the note above)');
  });

  test('S5: the gh note is dim when stderr has colour, and plain when it does not', () => {
    pinGithub(box);
    guardOn(box);
    const plain = repown(['status'], box.dir, fakeGhEnv(box));
    assert.match(plain.stderr, /^NOTE  gh/m);
    assert.doesNotMatch(plain.stderr, /\x1b/);
    const coloured = repown(['status'], box.dir, fakeGhEnv(box, { FORCE_COLOR: '1' }));
    assert.match(coloured.stderr, /\x1b\[2mNOTE \x1b\[0m gh         active as "octo-work"/);
  });

  test('S5: no problems, only a gh could-not-be-queried warning', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box, { GH_FAKE_FAIL: '1' }));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}gh {9}could not be queried/);
    assert.doesNotMatch(run.stderr, /NOTE {2}gh/);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
  });

  test('S6: a non-gh warning is ready with the count, not tagged optional', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}guard/);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
    assert.doesNotMatch(run.stderr, /optional: gh/);
  });

  test('S6: a gh note mixed with a real warning is not part of the tally', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}guard/);
    assert.match(run.stderr, /NOTE {2}gh/);
    assert.ok(run.stderr.indexOf('WARN  guard') < run.stderr.indexOf('NOTE  gh'), run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
    assert.doesNotMatch(run.stderr, /gh: optional/);
  });

  test('S7: a problem does not count the gh note, and the note follows the failure', () => {
    pinGithub(box);
    guardOn(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    const run = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /FAIL {2}identity/);
    assert.match(run.stderr, /NOTE {2}gh/);
    assert.doesNotMatch(run.stdout, /OK {4}identity/);
    assert.ok(run.stderr.indexOf('FAIL  identity') < run.stderr.indexOf('NOTE  gh'), run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(closing(run.stderr), '1 problem');
  });

  test('S7: a problem keeps today\'s tally and prints no ready line', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(closing(run.stderr), '1 problem, 1 warning: run repown setup');
    assert.doesNotMatch(run.stderr, /ready:/);
  });

  test('S7: gh as the helper still ends with 1 problem, no ready line', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(closing(run.stderr), '1 problem');
    assert.doesNotMatch(run.stderr, /ready:/);
  });

  test('the ready account matches the account field\'s spelling', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Cat', 'octocat@example.invalid');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded)');
    assert.equal(closing(run.stderr), 'ready: commits and pushes use Octocat');
  });

  test('a host with no credential pin does not claim the push identity', () => {
    box.git('remote', 'add', 'origin', 'https://dev.azure.com/octocat/project/_git/repo');
    box.git('config', '--local', 'user.name', 'Octo Cat');
    box.git('config', '--local', 'user.email', 'octocat@example.invalid');
    box.git('config', '--local', 'repown.account', 'octocat');
    guardOn(box);
    const clean = repown(['status'], box.dir, quietEnv());
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(closing(clean.stderr), 'ready: commits use octocat; pushes use this host\'s own sign-in');
    assert.doesNotMatch(clean.stderr, /commits and pushes use/);
    const warned = repown(['status'], box.dir, fakeGhEnv(box));
    assert.equal(warned.status, 0, warned.stderr);
    assert.equal(counted(warned.stderr, 'WARN'), 0, warned.stderr);
    assert.match(warned.stderr, /NOTE {2}gh/);
    assert.equal(closing(warned.stderr),
      'ready: commits use octocat; pushes use this host\'s own sign-in · gh: optional (see the note above)');
    box.git('remote', 'set-url', 'origin', join(box.dir, 'elsewhere.git'));
    const local = repown(['status'], box.dir, quietEnv());
    assert.equal(local.status, 0, local.stderr);
    assert.equal(closing(local.stderr), 'ready: commits use octocat; pushes use this host\'s own sign-in');
  });
});

describe('repown status: what will stop the next push', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  const theirs = (): void => {
    box.git('-c', 'user.name=Someone', '-c', 'user.email=old@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'theirs');
  };
  const warnings = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('WARN  '));

  test('commits by another address come first among the warnings, and there is no ready line', () => {
    pinGithub(box);
    guardOn(box);
    theirs();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(warnings(run.stderr)[0] ?? '', /^WARN\s+push\s+1 commit on main not on any remote is by old@example\.invalid/);
    assert.doesNotMatch(run.stderr, /ready:/);
    assert.equal(closing(run.stderr), 'the next push will fail: 1 commit by another address');
  });

  test('with the guard off, commits by another address are a warning and the clone is ready', () => {
    pinGithub(box);
    theirs();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.match(warnings(run.stderr)[0] ?? '', /^WARN\s+push\s+1 commit on main not on any remote is by old@example\.invalid; the guard is off, so it pushes as it is/);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 2 warnings');
  });

  test('a variable the guard refuses is named, with the others counted after the first', () => {
    pinGithub(box);
    guardOn(box);
    theirs();
    const run = repown(['status'], box.dir, { ...quietEnv(), GH_TOKEN: 'not-a-real-token' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN\s+push\s+GH_TOKEN is set in this shell/);
    assert.doesNotMatch(run.stderr, /not-a-real-token/);
    assert.equal(closing(run.stderr), 'the next push will fail: 1 commit by another address (and 1 more above)');
  });

  test('a push to another owner is said once, by the origin warning, and still is not ready', () => {
    pinGithub(box);
    guardOn(box);
    box.git('remote', 'set-url', 'origin', 'https://github.com/octo-org/project.git');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(warnings(run.stderr).filter((line) => line.includes('octo-org')).length, 1, run.stderr);
    assert.match(closing(run.stderr), /^the next push will fail: the push goes to "octo-org"/);
  });

  test('a missing upstream stays in its field, not a warning, and the clone is still ready', () => {
    pinGithub(box);
    guardOn(box);
    box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'mine');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.match(closing(run.stderr), /^ready: /);
  });
});

describe('repown status account', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S8: pinned, recorded, and this clone matches the record', () => {
    pinGithub(box);
    record(box, 'octocat', 'Octo Cat', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (recorded)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
    const coloured = repown(['status'], box.dir, { ...process.env, FORCE_COLOR: '1' });
    assert.match(coloured.stdout, /octocat {2}\x1b\[2m\(recorded\)\x1b\[0m/);
  });

  test('S8: the registry key\'s spelling is shown, and email matches ignoring case', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Cat', 'OctoCat@Example.Invalid');
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
  });

  test('S8: a different name warns, and the fix names the registry key', () => {
    pinGithub(box);
    record(box, 'Octocat', 'Octo Work', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        Octocat  (recorded as Octo Work <octocat@example.invalid>)');
    const warn = 'this clone commits as Octo Cat <octocat@example.invalid>, but Octocat is recorded as Octo Work <octocat@example.invalid>.';
    assert.ok(run.stderr.includes('WARN  account    ' + warn), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown use Octocat'), run.stderr);
  });

  test('S8: a different email warns the same way', () => {
    pinGithub(box);
    record(box, 'octocat', 'Octo Cat', 'octo-work@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (recorded as Octo Cat <octo-work@example.invalid>)');
    const warn = 'this clone commits as Octo Cat <octocat@example.invalid>, but octocat is recorded as Octo Cat <octo-work@example.invalid>.';
    assert.ok(run.stderr.includes('WARN  account    ' + warn), run.stderr);
  });

  test('S8: pinned, but not in this machine\'s registry', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(accountLine(run.stdout), '  account        octocat  (not in this machine\'s registry)');
    assert.doesNotMatch(run.stderr, /WARN {2}account/);
  });

  test('S8: the pin is repown.account, otherwise the credential username', () => {
    pinGithub(box);
    box.git('config', '--local', 'repown.account', 'octo-work');
    const owner = repown(['status'], box.dir);
    assert.equal(accountLine(owner.stdout), '  account        octo-work  (not in this machine\'s registry)');
    box.git('config', '--local', '--unset', 'repown.account');
    const credential = repown(['status'], box.dir);
    assert.equal(accountLine(credential.stdout), '  account        octocat  (not in this machine\'s registry)');
  });

  test('S8: not pinned lists registry keys in registry order', () => {
    record(box, 'octo-work', 'Octo Work', 'octo-work@example.invalid');
    record(box, 'octocat', 'Octo Cat', 'octocat@example.invalid');
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        not pinned  (recorded: octo-work, octocat)');
  });

  test('S8: not pinned, and nothing recorded', () => {
    const run = repown(['status'], box.dir);
    assert.equal(accountLine(run.stdout), '  account        not pinned  (none recorded)');
  });

  test('S8: an unreadable registry is reported and the exit code stays', async () => {
    pinGithub(box);
    breakRegistry();
    const loaded = await loadRegistry();
    const error = loaded.ok ? '' : loaded.error;
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.notEqual(error, '');
    assert.equal(accountLine(run.stdout), '  account        registry could not be read: ' + error);
    assert.doesNotMatch(run.stdout, /none recorded/);
    assertRegistryWarning(run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 2 warnings');
    assert.doesNotMatch(run.stderr, /run repown setup/);
  });

  test('S8: an unreadable registry never looks like none recorded', () => {
    breakRegistry();
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.match(accountLine(run.stdout), /^ {2}account {8}registry could not be read: /);
    assert.doesNotMatch(run.stdout, /none recorded/);
    assertRegistryWarning(run.stderr);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });
});

describe('gh warning account', () => {
  test('signed in to gh: the fix switches, in the spelling gh reports', () => {
    const advice = ghAdvice('octo-work', ghAccounts('octocat', ['octocat', 'octo-work']));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: gh auth switch -u octo-work');
  });

  test('signed in under a different case: the fix uses the login gh reports', () => {
    const advice = ghAdvice('Octo-Work', ghAccounts('octocat', ['octocat', 'octo-work']));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: gh auth switch -u octo-work');
  });

  test('not signed in to gh: the fix is repown use --gh', () => {
    const advice = ghAdvice('octo-work', ghActive('octocat'));
    assert.ok(advice);
    assert.equal(advice.level, 'note');
    assert.match(advice.text, /active as "octocat"/);
    assert.equal(advice.detail, 'fix: repown use octo-work --gh   (signs octo-work in to gh)');
  });

  test('empty hosts is nobody signed in, not an unverified gh', () => {
    const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(ghAdvice('octocat', { ghPresent: true, gh: parsed }), null);
  });

  test('unverified gh stays a check of gh auth status', () => {
    const advice = ghAdvice('octocat', ghUnverified());
    assert.deepEqual(advice, {
      level: 'warn',
      text: 'could not be queried, so who `gh pr create` would act as is UNVERIFIED.',
      detail: 'check it yourself: gh auth status',
    });
  });
});

const SETUP_FIX = '       fix: repown setup   (or: repown use <account>)';

describe('repown status failure pointers', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S9: an unpinned clone\'s fix is setup, or use', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('FAIL  identity   This clone sets no identity of its own'), run.stderr);
    assert.ok(run.stderr.includes(SETUP_FIX), run.stderr);
  });

  test('S9: a clone with no push account has the same fix', () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    box.git('config', '--local', 'user.name', 'Octo Cat');
    box.git('config', '--local', 'user.email', 'octocat@example.invalid');
    box.git('config', '--local', 'credential.helper', 'manager');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('FAIL  identity   No account is pinned'), run.stderr);
    assert.ok(run.stderr.includes(SETUP_FIX), run.stderr);
    assert.equal(closing(run.stderr), '1 problem: run repown setup');
  });

  test('S9: gh as the helper still says repown fix, with no setup pointer', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('gh is the git credential helper'), run.stderr);
    assert.ok(run.stderr.includes('       fix: repown fix'), run.stderr);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(closing(run.stderr), '1 problem');
  });

  test('S9: unpinned with the guard off counts one problem and one warning', () => {
    unpin(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), '1 problem, 1 warning: run repown setup');
  });

  test('S9: two warnings pluralise, and an identity problem still points at setup', () => {
    unpin(box);
    writeFileSync(join(box.dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/octocat/lib.git\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 1, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 2, run.stderr);
    assert.equal(closing(run.stderr), '1 problem, 2 warnings: run repown setup');
  });

  test('S9: two problems pluralise, and the identity one still points at setup', () => {
    unpin(box);
    box.git('config', '--local', 'credential.helper', '!gh auth git-credential');
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 1);
    assert.equal(counted(run.stderr, 'FAIL'), 2, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 0, run.stderr);
    assert.equal(closing(run.stderr), '2 problems: run repown setup');
  });

  test('S9: warnings alone do not point at setup', () => {
    pinGithub(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0);
    assert.equal(counted(run.stderr, 'FAIL'), 0, run.stderr);
    assert.equal(counted(run.stderr, 'WARN'), 1, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat · 1 warning');
  });

  test('S9: a clean run still says ready, on stderr', () => {
    pinGithub(box);
    guardOn(box);
    const run = repown(['status'], box.dir, quietEnv());
    assert.equal(run.status, 0, run.stderr);
    assert.equal(closing(run.stderr), 'ready: commits and pushes use octocat');
    assert.doesNotMatch(run.stdout, /ready:/);
  });

  test('S9: a foreign pre-push hook is counted in the closing tally', () => {
    pinGithub(box);
    const hooks = join(box.dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /a pre-push hook repown did not write/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: core.hooksPath redirected is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', 'core.hooksPath', join(box.dir, 'husky'));
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /core\.hooksPath/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: no credential helper on a pinned GitHub clone is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', '--unset', 'credential.helper');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /no credential helper is set/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });

  test('S9: a non-GCM helper is counted in the closing tally', () => {
    pinGithub(box);
    box.git('config', '--local', 'credential.helper', 'store');
    const run = repown(['status'], box.dir, quietEnv());
    assert.match(run.stderr, /"store" serves credentials here/);
    assert.equal(counted(run.stderr), tallyCount(run.stderr), run.stderr);
  });
});

describe('repown status outside a repository', () => {
  test('S10: the failure is unchanged and no title is printed', () => {
    // realpath: macOS's tmpdir is /var, a link to /private/var, and the child's cwd is the real path.
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'repown-not-a-repo-')));
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = join(empty, '..');
    try {
      const run = repown(['status'], empty);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, notARepo(empty));
    } finally {
      restoreCeiling(saved);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function accountLine(stdout: string): string {
  const found = stdout.split('\n').find((text) => text.startsWith('  account '));
  assert.ok(found, stdout);
  return found;
}

function upstreamLine(stdout: string): string | undefined {
  return stdout.split('\n').find((text) => text.startsWith('  upstream '));
}

function fieldLine(label: string, value: string): string {
  return '  ' + label.padEnd(14) + ' ' + value;
}

/** Git's work-tree path uses forward slashes. Shown paths use the platform's own. */
function shownPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('/', '\\') : path;
}

const GH_ACTIVE_NOTE = 'NOTE  gh         active as "octo-work", so `gh pr create` here would act as ' +
  'that account. git pushes are unaffected; this only matters if you use gh here.';

function track(box: Sandbox, ref: string): void {
  box.git('commit', '--allow-empty', '-m', 'base');
  box.git('update-ref', 'refs/remotes/' + ref, 'HEAD');
  box.git('branch', '--set-upstream-to=' + ref);
}

function record(box: Sandbox, account: string, name: string, email: string): void {
  const run = repown(['accounts', 'add', account, '--name', name, '--email', email], box.dir);
  assert.equal(run.status, 0, run.stderr);
}

function breakRegistry(): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{');
}

function fieldsUnder(stdout: string, heading: string): string[] {
  const lines = stdout.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, heading + ' missing from\n' + stdout);
  const labels: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    labels.push(line.trim().split(/\s{2,}/)[0] ?? '');
  }
  return labels;
}

function pinGithub(box: Sandbox): void {
  box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
  box.git('config', '--local', 'user.name', 'Octo Cat');
  box.git('config', '--local', 'user.email', 'octocat@example.invalid');
  box.git('config', '--local', 'repown.account', 'octocat');
  box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
  box.git('config', '--local', 'credential.helper', 'manager');
}

function unpin(box: Sandbox): void {
  box.git('config', '--local', '--unset', 'user.name');
  box.git('config', '--local', '--unset', 'user.email');
}

/** gh on PATH would add a machine-dependent warning; a clean count needs it absent. */
function quietEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: pathWithoutGh() };
}

function fakeGhEnv(box: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = join(box.dir, '..', 'fake-gh-bin');
  mkdirSync(bin, { recursive: true });
  installFakeGh(bin);
  const env = quietEnv();
  return { ...env, ...extra, PATH: bin + delimiter + (env['PATH'] ?? '') };
}

function installFakeGh(bin: string): void {
  if (process.platform === 'win32') copyFileSync(compileFakeExe('gh.exe', FAKE_GH_CS), join(bin, 'gh.exe'));
  else writeFileSync(join(bin, 'gh'), FAKE_GH_SH, { mode: 0o755 });
}

const FAKE_GH_CS = `
using System;
class FakeGh {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("gh version 2.88.1 (2026-03-12)");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("GH_FAKE_FAIL") == "1") return 1;
    if (args.Length >= 2 && args[0] == "auth" && args[1] == "status") {
      Console.WriteLine("{\\"hosts\\":{\\"github.com\\":[{\\"login\\":\\"octo-work\\",\\"active\\":true}]}}");
      return 0;
    }
    return 97;
  }
}
`;

const FAKE_GH_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.88.1 (2026-03-12)"; exit 0; fi
if [ "$GH_FAKE_FAIL" = "1" ]; then exit 1; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"hosts":{"github.com":[{"login":"octo-work","active":true}]}}'
  exit 0
fi
exit 97
`;

function guardOn(box: Sandbox): void {
  const run = repown(['guard', 'on'], box.dir);
  assert.equal(run.status, 0, run.stderr);
}

function counted(stderr: string, word?: 'FAIL' | 'WARN'): number {
  const lines = stderr.split('\n');
  if (word === undefined) return lines.filter((line) => line.startsWith('FAIL  ') || line.startsWith('WARN  ')).length;
  return lines.filter((line) => line.startsWith(word + '  ')).length;
}

/** Problems plus warnings named by the closing tally. */
function tallyCount(stderr: string): number {
  const line = closing(stderr)
    .replace(/^ready: commits and pushes use \S+ · /, '')
    .replace(/^ready: commits use \S+; pushes use this host's own sign-in · /, '')
    .replace(/: run repown setup$/, '');
  return [...line.matchAll(/(\d+) /g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

function assertRegistryWarning(stderr: string): void {
  assert.ok(stderr.includes('WARN  account    the account registry could not be read, so this clone\'s account was not compared with it.'), stderr);
  assert.ok(stderr.includes('       see: repown accounts list'), stderr);
}

function ghActive(login: string): AuthState {
  return ghAccounts(login, [login]);
}

function ghAccounts(active: string, logins: readonly string[]): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: ok({
      accounts: logins.map((login) => ({ login, active: login === active })),
      active,
    }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

function ghUnverified(): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: err('gh auth status failed'),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

/** The last stderr line, which must stand after a blank line. */
function closing(stderr: string): string {
  const lines = stderr.split('\n');
  assert.equal(lines.at(-1), '', stderr);
  assert.equal(lines.at(-3), '', stderr);
  return lines.at(-2) ?? '';
}

function notARepo(dir: string): string {
  return 'FAIL  repown     Not a git repository: ' + dir + '\n' +
    '       repown pins an identity per clone, so it needs one to work in.\n';
}

function restoreCeiling(saved: string | undefined): void {
  if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = saved;
}
