import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

// A hook or husky-style tool exports GIT_DIR. Inherited by `npm test`, it
// pointed every sandbox git call at the developer's real repository -- which
// the tests then pinned to "Sandbox <sandbox@example.invalid>".
describe('sandbox isolation', () => {
  test('an inherited GIT_DIR (or identity variable) does not escape the sandbox', () => {
    const decoy = mkdtempSync(join(tmpdir(), 'repown-decoy-'));
    execFileSync('git', ['init', '-q', decoy]);
    const saved = { dir: process.env['GIT_DIR'], email: process.env['GIT_AUTHOR_EMAIL'] };
    process.env['GIT_DIR'] = join(decoy, '.git');
    process.env['GIT_AUTHOR_EMAIL'] = 'leak@example.invalid';
    const box = sandbox();
    try {
      const decoyName = spawnSync('git', ['config', '--local', '--get', 'user.name'],
        { cwd: decoy, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(decoy, '.git') } });
      assert.equal(decoyName.stdout.trim(), '', 'the decoy repository was written to');
      assert.equal(process.env['GIT_AUTHOR_EMAIL'], undefined);
    } finally {
      box.dispose();
      rmSync(decoy, { recursive: true, force: true });
      if (saved.dir === undefined) delete process.env['GIT_DIR']; else process.env['GIT_DIR'] = saved.dir;
      if (saved.email !== undefined) process.env['GIT_AUTHOR_EMAIL'] = saved.email;
    }
  });
});

describe('Git', () => {
  let box: Sandbox;
  let git: Git;

  before(() => { box = sandbox(); git = new Git(box.dir); });
  after(() => box.dispose());

  test('an unset key is an ANSWER, not a failure', async () => {
    assert.equal(await git.getConfig('no.such.key'), null);
  });

  test('reads a key that is set', async () => {
    box.git('config', '--local', 'repown.probe', 'value');
    assert.equal(await git.getConfig('repown.probe'), 'value');
  });

  test('unsetting an absent key succeeds rather than erroring', async () => {
    assert.equal(await git.unsetConfig('never.existed'), true);
  });

  // `repown scan` runs `git log` in every repository it finds. With
  // log.showSignature and gpg.program set in a repository's own config, a
  // signed commit makes git run that program -- code execution from a tree the
  // user merely scanned.
  test('reading history never runs a signature program the repository configures', async () => {
    const marker = join(box.dir, '..', 'RAN');
    const program = join(box.dir, '..', 'fake-gpg.sh');
    writeFileSync(program, '#!/bin/sh\ntouch "' + marker.replace(/\\/g, '/') + '"\nexit 1\n', { mode: 0o755 });
    const tree = execFileSync('git', ['mktree'], { cwd: box.dir, input: '', encoding: 'utf8' }).trim();
    const signed = 'tree ' + tree + '\nauthor a <a@example.invalid> 1 +0000\ncommitter a <a@example.invalid> 1 +0000\n' +
      'gpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n';
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'],
      { cwd: box.dir, input: signed, encoding: 'utf8' }).trim();
    box.git('update-ref', 'refs/heads/signed', sha);
    box.git('config', '--local', 'log.showSignature', 'true');
    box.git('config', '--local', 'gpg.program', program.replace(/\\/g, '/'));
    try {
      await git.emailCounts();
      await git.identitiesIn([sha]);
      assert.equal(existsSync(marker), false, 'the configured program must not have run');
    } finally {
      box.git('config', '--local', '--unset', 'log.showSignature');
      box.git('update-ref', '-d', 'refs/heads/signed');
    }
  });

  test('a history that cannot be read is an ERROR, not an empty history', async () => {
    const counts = await git.emailCounts('refs/heads/no-such-branch');
    assert.equal(counts.ok, false);
  });

  // git prints `file:<path>\t<key> <value>` with the path unquoted, and on
  // Windows every system entry lives under `C:/Program Files/...`.
  test('configOrigins keeps a config file path that contains a space', async () => {
    const included = join(box.dir, '..', 'with space.gitconfig');
    writeFileSync(included, '[repown]\n\tprobe2 = value\n');
    box.git('config', '--local', 'include.path', included.replace(/\\/g, '/'));
    try {
      const origins = await git.configOrigins('^repown\\.probe2$');
      assert.equal(origins.length, 1);
      assert.match(origins[0]!.file, /with space\.gitconfig$/);
      assert.equal(origins[0]!.value, 'value');
    } finally {
      box.git('config', '--local', '--unset', 'include.path');
    }
  });

  test('getAllConfig returns every value of a multi-valued key', async () => {
    box.git('config', '--local', '--add', 'repown.multi', 'one');
    box.git('config', '--local', '--add', 'repown.multi', 'two');
    assert.deepEqual(await git.getAllConfig('repown.multi'), ['one', 'two']);
  });

  test('an empty credential helper RESETS the list, discarding what came before', async () => {
    // Exactly what `gh auth setup-git` writes. The empty value is defined by
    // gitcredentials(7) as a list reset, so `manager` must NOT survive it.
    box.writeGlobalConfig([
      '[credential]',
      '\thelper = manager',
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !gh auth git-credential',
      '',
    ].join('\n'));

    const effective = await git.getUrlMatch('credential.helper', 'https://github.com/');
    assert.ok(effective !== null, 'a helper must resolve');
    assert.ok(!/manager/.test(effective), `manager must be discarded, got: ${effective}`);
    assert.match(effective, /gh auth git-credential/);
  });

  test('without the reset, the configured helper survives', async () => {
    box.writeGlobalConfig('[credential]\n\thelper = manager\n');
    const effective = await git.getUrlMatch('credential.helper', 'https://github.com/');
    assert.equal(effective, 'manager');
  });

  test('reads author and committer of each commit in a range', async () => {
    box.git('commit', '--allow-empty', '-m', 'first');
    box.git('-c', 'user.email=other@example.invalid',
            'commit', '--allow-empty', '-m', 'second');

    const result = await git.identitiesIn(['HEAD']);
    assert.ok(result.ok);
    const found = result.value;
    assert.equal(found.length, 2);
    assert.equal(found[0]?.subject, 'second');
    assert.equal(found[0]?.authorEmail, 'other@example.invalid');
    assert.equal(found[1]?.authorEmail, 'sandbox@example.invalid');
  });

  test('commonDir resolves, and is where hooks live', async () => {
    const common = await git.commonDir();
    assert.ok(common && common.length > 0);
  });

  test('isRepo is false outside a repository', async () => {
    // A TEMP inside a git repository (a dotfiles home) would otherwise answer true.
    const outside = join(box.dir, '..');
    const saved = process.env['GIT_CEILING_DIRECTORIES'];
    process.env['GIT_CEILING_DIRECTORIES'] = join(outside, '..');
    try {
      assert.equal(await new Git(outside).isRepo(), false);
    } finally {
      if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
      else process.env['GIT_CEILING_DIRECTORIES'] = saved;
    }
  });
});

describe('empty config values', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('an EMPTY helper value is preserved, because it is the list reset', async () => {
    // This is exactly what `gh auth setup-git` writes. Dropping the blank made
    // `repown fix` preview half of what it was about to remove, and hid the line
    // that explains why credentials broke.
    box.writeGlobalConfig([
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !gh auth git-credential',
      '',
    ].join('\n'));

    const git = new Git(box.dir);
    const raw = await git.getAllConfigRaw('credential.https://github.com.helper', 'global');
    assert.equal(raw.length, 2, 'both values must survive');
    assert.equal(raw[0], '', 'the list reset is the first value');
    assert.match(raw[1]!, /gh auth git-credential/);

    // The filtering reader still drops it -- that is its job elsewhere.
    const filtered = await git.getAllConfig('credential.https://github.com.helper', 'global');
    assert.equal(filtered.length, 1);
  });
});
