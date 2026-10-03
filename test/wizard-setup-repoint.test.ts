// repown setup repointing a branch and fetching, in a real clone (split from wizard-setup.test.ts).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { setupContext as context } from './setup-fixtures.ts';
import { ok, err } from '../src/core/result.ts';
import { wizard, BACK, CANCEL, type Answers, type Prompter, type Reply, type Review, type ReviewChoice, type StepConfirm } from '../src/wizard/engine.ts';
import { setupFlow, planCommands, formatCommand, gitStepOf, keptFlags, blockersOf, changesOf, briefOf, missingFlags, printable, NEW_ACCOUNT, DETECTED_PREFIX, accountOf, isNew, signedInLogins, type SetupContext, type Suggestion } from '../src/wizard/setup-flow.ts';
import { pinWrites } from '../src/core/identity.ts';
import { plainPrompter } from '../src/wizard/plain.ts';
import { reviewLines, reviewDefault } from '../src/wizard/review-text.ts';
import { gitSupportsAutoUpstream } from '../src/core/version.ts';
import { SETUP_NOTE } from '../src/commands/start.ts';
import { runSetup } from '../src/wizard/setup-run.ts';
import { cloneChangeLines, machineChangeLines, readCloneSnapshot, type CloneSnapshot } from '../src/wizard/setup-changes.ts';
import { readContext } from '../src/wizard/setup-context.ts';
import { Git } from '../src/core/git.ts';
import type { AuthState } from '../src/core/inspect.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { inherit, handingOver } from '../src/core/exec.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import {
  CLI, scripted, answer, textOf, argvOf, onBranch, reviewNotes, commitAt, restoreEnv, plainChoice, stepOf, wording, shellSplit, home, record, repown, localConfig, hook, shot, sectionLines, expectedPin, ghAuth, WAIT_CHILD, plainLead, guarded, holdInherit, untilUp, releaseInherit, captureStep, type Entry, type Home,
} from './wizard-setup-helpers.ts';

describe('repown setup: repoint and fetch, in a real clone', () => {
  let at: Home;
  beforeEach(() => { at = home(); record(at, 'octocat', 'octocat@example.invalid'); });
  afterEach(() => at.dispose());

  /** A bare origin holding the first commit, never fetched here (no tracking refs), then a commit by another address. */
  const unfetchedOrigin = (): string => {
    const path = join(at.box.dir, '..', 'origin.git');
    at.box.git('init', '-q', '--bare', path);
    at.box.git('remote', 'add', 'origin', path);
    at.box.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    at.box.git('update-ref', '-d', 'refs/remotes/origin/main');
    at.box.git('-c', 'user.name=Someone', '-c', 'user.email=old@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'theirs');
    return path;
  };
  const tracking = (): string => at.box.git('for-each-ref', 'refs/remotes/origin/');

  test('--fetch fetches the destination first; --no-input without it does not', () => {
    unfetchedOrigin();
    assert.equal(repown(['setup', 'octocat', '--no-input'], at.box.dir).status, 0);
    assert.equal(tracking(), '', 'no fetch unless asked');
    at.box.git('config', '--local', '--unset', 'repown.account');
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /step 1 of \d: Fetch origin/);
    assert.match(run.stderr, /\$ git fetch origin/);
    assert.notEqual(tracking(), '');
  });

  test('a failed fetch warns, the rest of the plan runs, and the destination stays unknown', () => {
    rmSync(unfetchedOrigin(), { recursive: true, force: true });
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout + run.stderr, /WARN\s+fetch\s+could not fetch origin \(/);
    assert.match(localConfig(at), /account = octocat/);
    assert.equal(tracking(), '');
  });

  test('--fetch where nothing needs fetching says so and fetches nothing', () => {
    const run = repown(['setup', 'octocat', '--fetch', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--fetch: /);
    assert.doesNotMatch(run.stderr, /\$ git fetch/);
  });

  test('the field case, re-authored: the closing line says done and the push passes the guard', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--guard', '--auto-upstream', '--reauthor', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /\$ repown reauthor --yes/);
    assert.match(run.stderr, /done: this clone is set up for octocat/);
    assert.equal(at.box.git('log', '-1', '--format=%ae|%ce'), 'octocat@example.invalid|octocat@example.invalid');
    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: at.box.dir, encoding: 'utf8', env: process.env });
    assert.equal(push.status, 0, push.stderr);
  });

  test('the field case, not re-authored: the closing line names the commits the guard will refuse', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--guard', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /repown reauthor/);
    assert.match(run.stderr, /set up for octocat; the next push will fail: 1 commit by another address/);
    const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: at.box.dir, encoding: 'utf8', env: process.env });
    assert.notEqual(push.status, 0, 'the guard refuses it');
  });

  test('the field case with the guard left off: done, and the commits named as a warning', () => {
    unfetchedOrigin();
    const run = repown(['setup', 'octocat', '--fetch', '--auto-upstream', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /done: this clone is set up for octocat$/m);
    assert.match(run.stderr, /1 commit on main not on any remote is by old@example\.invalid; the guard is off, so it pushes as it is/);
  });

  test('--reauthor with nothing by another address says so and rewrites nothing', () => {
    const path = join(at.box.dir, '..', 'origin.git');
    at.box.git('init', '-q', '--bare', path);
    at.box.git('remote', 'add', 'origin', path);
    at.box.git('push', '-q', '-u', 'origin', 'HEAD:main');
    const before = at.box.git('rev-parse', 'HEAD');
    const run = repown(['setup', 'octocat', '--reauthor', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /--reauthor: /);
    assert.equal(at.box.git('rev-parse', 'HEAD'), before);
  });

  test('--repoint points the branch back at its remote, and nothing prints the URL', () => {
    at.box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    at.box.git('config', 'branch.main.remote', 'https://octocat:ghp_secret@github.com/octocat/project.git');
    const kept = repown(['setup', 'octocat', '--no-input'], at.box.dir);
    assert.equal(at.box.git('config', 'branch.main.remote'), 'https://octocat:ghp_secret@github.com/octocat/project.git', 'not without --repoint');
    assert.doesNotMatch(kept.stdout + kept.stderr, /ghp_secret/);
    const run = repown(['setup', 'octocat', '--repoint', '--no-input'], at.box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(at.box.git('config', 'branch.main.remote'), 'origin');
    assert.match(run.stderr, /\$ git config --local branch\.main\.remote origin/);
    assert.match(run.stderr, /branch\.main\.remote: \(a URL\) -> origin/);
    assert.doesNotMatch(run.stdout + run.stderr, /ghp_secret|octocat:/);
  });
});
