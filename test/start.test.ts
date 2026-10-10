// Bare `repown` chooses setup, status, the start screen or the top help. S1-S4, H1-H4.
// "Set up" is what identityProblems accepts: a name and email, and on GitHub
// https the credential username too.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git } from '../src/core/git.ts';
import { registryPath } from '../src/core/registry.ts';
import { chooseStart, minttyWithoutConsole, startDefault } from '../src/commands/start.ts';
import { sandbox, type Sandbox } from './helpers.ts';

describe('chooseStart', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S1: an unpinned clone in a terminal starts setup', async () => {
    unpin(box);
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
  });

  test('S1: GitHub https with no credential username is not set up', async () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
  });

  test('S2: a pinned clone in a terminal starts setup', async () => {
    pinGithub(box);
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
  });

  test('S2: name and email, with no credential key to pin, starts setup', async () => {
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
  });

  test('S3: an unpinned clone without a terminal shows status', async () => {
    unpin(box);
    assert.equal(await chooseStart(deps(box, false, false)), 'status');
  });

  test('S3: an unpinned clone with stdout redirected shows status', async () => {
    unpin(box);
    assert.equal(await chooseStart(deps(box, true, false)), 'status');
  });

  test('S3: a pinned clone with stdout redirected shows status', async () => {
    pinGithub(box);
    assert.equal(await chooseStart(deps(box, true, false)), 'status');
  });

  test('H2: a bare repository in a terminal opens the start screen', async () => {
    assert.equal(await chooseStart({ interactive: true, stdoutIsTerminal: true, git: new Git(bareRepo(box)) }), 'home');
  });

  test('a bare repository with stdout redirected still shows help', async () => {
    assert.equal(await chooseStart({ interactive: true, stdoutIsTerminal: false, git: new Git(bareRepo(box)) }), 'help');
  });

  test('S11: a bare repository without a terminal shows status', async () => {
    assert.equal(await chooseStart({ interactive: false, stdoutIsTerminal: false, git: new Git(bareRepo(box)) }), 'status');
  });

  test('S12: an unreadable registry in a terminal still starts setup', async () => {
    pinGithub(box);
    breakRegistry();
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
  });
});

describe('chooseStart outside a repository', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('H1: a terminal that is not a clone opens the start screen', async () => {
    await outside((git) => chooseStart({ interactive: true, stdoutIsTerminal: true, git }).then((choice) => {
      assert.equal(choice, 'home');
    }));
  });

  test('H3: help still prints when stdout is redirected', async () => {
    await outside((git) => chooseStart({ interactive: true, stdoutIsTerminal: false, git }).then((choice) => {
      assert.equal(choice, 'help');
    }));
  });

  test('H4: without a terminal, not being a clone still shows status', async () => {
    await outside((git) => chooseStart({ interactive: false, stdoutIsTerminal: false, git }).then((choice) => {
      assert.equal(choice, 'status');
    }));
  });
});

describe('startDefault', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('S1: an unpinned clone returns the setup runner and prints nothing', async () => {
    unpin(box);
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
    const run = await captured(() => startDefault(deps(box, true, true)));
    assert.equal(typeof run.choice, 'function');
    assert.equal(run.stderr, '');
  });

  test('a pinned clone returns the setup runner and prints nothing', async () => {
    pinGithub(box);
    assert.equal(await chooseStart(deps(box, true, true)), 'setup');
    const run = await captured(() => startDefault(deps(box, true, true)));
    assert.equal(typeof run.choice, 'function');
    assert.equal(run.stderr, '');
  });

  test('status and help print nothing; the start screen prints nothing until it runs', async () => {
    const status = await captured(() => startDefault(deps(box, true, false)));
    assert.equal(status.choice, 'status');
    assert.equal(status.stderr, '');
    await outside(async (git) => {
      const help = await captured(() => startDefault({ interactive: true, stdoutIsTerminal: false, git }));
      assert.equal(help.choice, 'help');
      assert.equal(help.stderr, '');
      const home = await captured(() => startDefault({ interactive: true, stdoutIsTerminal: true, git }));
      assert.equal(typeof home.choice, 'function');
      assert.equal(home.stderr, '');
    });
  });

  test('H2: a bare repository in a terminal returns the home runner and prints nothing', async () => {
    const home = await captured(() => startDefault({ interactive: true, stdoutIsTerminal: true, git: new Git(bareRepo(box)) }));
    assert.equal(typeof home.choice, 'function');
    assert.equal(home.stderr, '');
  });
});

describe('Git Bash on mintty without a console (#25)', () => {
  test('is mintty on Windows with stdin not a terminal, and nothing else', () => {
    assert.equal(minttyWithoutConsole({ TERM_PROGRAM: 'mintty' }, 'win32', false), true);
    assert.equal(minttyWithoutConsole({ TERM_PROGRAM: 'mintty' }, 'win32', true), false, 'winpty or ConPTY gives it one');
    assert.equal(minttyWithoutConsole({ TERM_PROGRAM: 'mintty' }, 'linux', false), false);
    assert.equal(minttyWithoutConsole({ TERM_PROGRAM: 'vscode' }, 'win32', false), false);
    assert.equal(minttyWithoutConsole({}, 'win32', false), false, 'a script or a pipe elsewhere');
  });

  test('there, bare repown still shows status, after a note that winpty repown opens the start screen', async () => {
    const box = sandbox();
    try {
      const picked = await captured(() => startDefault({ interactive: false, stdoutIsTerminal: false, git: new Git(box.dir), mintty: true }));
      assert.equal(typeof picked.choice, 'function');
      assert.equal(picked.stderr, '', 'nothing until it runs');
      const plain = await captured(() => startDefault({ interactive: false, stdoutIsTerminal: false, git: new Git(box.dir) }));
      assert.equal(plain.choice, 'status', 'anywhere else, status as before');
      const ran = await captured(() => (picked.choice as () => Promise<number>)());
      assert.match(ran.stderr, /mintty gives repown no console here, so it shows status: run winpty repown to be asked \(setup in a clone, the start screen outside one\)/);
    } finally {
      box.dispose();
    }
  });
});

function deps(box: Sandbox, interactive: boolean, stdoutIsTerminal: boolean): { interactive: boolean; stdoutIsTerminal: boolean; git: Git } {
  return { interactive, stdoutIsTerminal, git: new Git(box.dir) };
}

function bareRepo(box: Sandbox): string {
  const bare = join(box.dir, '..', 'bare.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  return bare;
}

function breakRegistry(): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{');
}

async function captured<T>(run: () => Promise<T>): Promise<{ choice: T; stderr: string }> {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { choice: await run(), stderr: chunks.join('') };
  } finally {
    process.stderr.write = write;
  }
}

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
