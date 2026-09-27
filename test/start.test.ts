// Bare `repown` chooses setup, status or the top help. S1-S4.
// "Set up" is what identityProblems accepts: a name and email, and on GitHub
// https the credential username too.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/core/git.ts';
import { chooseStart } from '../src/commands/start.ts';
import { sandbox, type Sandbox } from './helpers.ts';

describe('chooseStart', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S1: an unpinned clone in a terminal starts setup', async () => {
    unpin(box);
    assert.equal(await chooseStart({ interactive: true, git: new Git(box.dir) }), 'setup');
  });

  test('S1: GitHub https with no credential username is not set up', async () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    assert.equal(await chooseStart({ interactive: true, git: new Git(box.dir) }), 'setup');
  });

  test('S2: a pinned clone in a terminal shows status', async () => {
    pinGithub(box);
    assert.equal(await chooseStart({ interactive: true, git: new Git(box.dir) }), 'status');
  });

  test('S2: name and email, with no credential key to pin, shows status', async () => {
    assert.equal(await chooseStart({ interactive: true, git: new Git(box.dir) }), 'status');
  });

  test('S3: an unpinned clone without a terminal shows status', async () => {
    unpin(box);
    assert.equal(await chooseStart({ interactive: false, git: new Git(box.dir) }), 'status');
  });
});

describe('chooseStart outside a repository', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S4: a terminal that is not a clone shows help', async () => {
    await outside((git) => chooseStart({ interactive: true, git }).then((choice) => {
      assert.equal(choice, 'help');
    }));
  });

  test('without a terminal, not being a clone still shows status', async () => {
    await outside((git) => chooseStart({ interactive: false, git }).then((choice) => {
      assert.equal(choice, 'status');
    }));
  });
});

function unpin(box: Sandbox): void {
  box.git('config', '--local', '--unset', 'user.name');
  box.git('config', '--local', '--unset', 'user.email');
}

function pinGithub(box: Sandbox): void {
  box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
  box.git('config', '--local', 'user.name', 'Octo Cat');
  box.git('config', '--local', 'user.email', 'octocat@example.invalid');
  box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
}

async function outside(check: (git: Git) => Promise<void>): Promise<void> {
  const empty = mkdtempSync(join(tmpdir(), 'repown-not-a-repo-'));
  const saved = process.env['GIT_CEILING_DIRECTORIES'];
  process.env['GIT_CEILING_DIRECTORIES'] = join(empty, '..');
  try {
    await check(new Git(empty));
  } finally {
    restoreCeiling(saved);
    rmSync(empty, { recursive: true, force: true });
  }
}

function restoreCeiling(saved: string | undefined): void {
  if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = saved;
}
