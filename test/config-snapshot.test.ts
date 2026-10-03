// A config snapshot answers every config read exactly as git does (ADR-029): the same value,
// list, raw list or boolean as `git config [--scope] [--type=bool] --get[-all]`, from one
// `git config [--scope] --list -z` per scope. Each case below is read both ways and compared.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git, type ConfigScope } from '../src/core/git.ts';
import { ConfigSnapshot, snapshotOf } from '../src/core/config-snapshot.ts';
import type { ExecResult } from '../src/core/exec.ts';
import { sandbox, type Sandbox } from './helpers.ts';

const SCOPES: readonly (ConfigScope | undefined)[] = [undefined, 'local', 'global', 'system'];

const KEYS = [
  'a.b', 'A.B', 'a.missing', 'a.flag', 'a.n', 'a.z', 'a.y', 'a.bad', 'a.e', 'a.ml', 'a.spaced',
  'sec.SubCase.key', 'Sec.SubCase.Key', 'sec.subcase.key', 'credential.https://github.com.username',
  'x.inc', 'g.only', 's.only', 'over.ride', 'nodot',
];

/** The four reads a caller can make, by name, so a mismatch names the read. */
const READS = ['getConfig', 'getBoolConfig', 'getAllConfig', 'getAllConfigRaw'] as const;

async function readAll(git: Git, key: string, scope: ConfigScope | undefined): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const read of READS) out[read] = await git[read](key, scope);
  return out;
}

describe('a config snapshot reads what git reads', () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
    for (const value of ['one', '', '  spaced  ']) box.git('config', '--add', 'a.b', value);
    box.git('config', 'a.ml', 'x\ny');
    box.git('config', 'a.spaced', '  both  ');
    box.git('config', 'Sec.SubCase.Key', 'v');
    box.git('config', 'credential.https://github.com.username', 'octocat');
    box.git('config', 'over.ride', 'local');
    appendFileSync(join(box.dir, '.git', 'config'), '[a]\n\tflag\n\tn = 2k\n\tz = 0\n\ty = Yes\n\tbad = maybe\n\te =\n');
    const extra = join(box.dir, '..', 'included.gitconfig');
    writeFileSync(extra, '[x]\n\tinc = 1\n');
    box.git('config', '--global', 'include.path', extra);
    box.git('config', '--global', 'g.only', 'global');
    box.git('config', '--global', 'over.ride', 'global');
    box.git('config', '--system', 's.only', 'system');
  });
  afterEach(() => box.dispose());

  test('every read of every key, in every scope, matches git', async () => {
    const git = new Git(box.dir);
    const snapshot = new ConfigSnapshot(box.dir);
    for (const scope of SCOPES) {
      for (const key of KEYS) {
        assert.deepEqual(await readAll(snapshot, key, scope), await readAll(git, key, scope), (scope ?? 'effective') + ' ' + key);
      }
    }
  });

  test('includes are followed only when no scope is given, as git does', async () => {
    const snapshot = new ConfigSnapshot(box.dir);
    assert.equal(await snapshot.getConfig('x.inc'), '1');
    assert.equal(await snapshot.getConfig('x.inc', 'global'), null);
  });

  test('a snapshot reads each scope once for its plain getters; a boolean still asks git', async () => {
    let spawned = 0;
    class Counting extends ConfigSnapshot {
      protected override spawnGit(args: readonly string[], input?: string): Promise<ExecResult> {
        spawned += 1;
        return super.spawnGit(args, input);
      }
    }
    const snapshot = new Counting(box.dir);
    for (const key of KEYS) {
      for (const scope of SCOPES) {
        await snapshot.getConfig(key, scope);
        await snapshot.getAllConfig(key, scope);
        await snapshot.getAllConfigRaw(key, scope);
      }
    }
    assert.equal(spawned, SCOPES.length);
    await snapshot.getBoolConfig('a.flag');
    assert.equal(spawned, SCOPES.length + 1, 'git reads its own booleans');
  });

  test('a snapshot refuses to write, and passes every other git call through', async () => {
    const snapshot = new ConfigSnapshot(box.dir);
    await assert.rejects(snapshot.setConfig('a.b', 'two'), /only reads/);
    await assert.rejects(snapshot.addConfig('a.b', 'two', 'local'), /only reads/);
    await assert.rejects(snapshot.unsetConfig('a.b'), /only reads/);
    assert.equal(await snapshot.isRepo(), true);
    assert.equal(await snapshot.getUrlMatch('credential.username', 'https://github.com/x'), 'octocat');
    assert.equal(box.git('config', '--get-all', 'a.b').split('\n').length, 3, 'nothing was written');
  });

  test('snapshotOf wraps a plain Git once, and keeps a snapshot as it is', () => {
    const snapshot = snapshotOf(new Git(box.dir));
    assert.ok(snapshot instanceof ConfigSnapshot);
    assert.equal(snapshotOf(snapshot), snapshot);
  });
});

test('booleans git reads its own way (hex, a leading space, out of range) are git\'s answer', async () => {
  const box = sandbox();
  try {
    appendFileSync(join(box.dir, '.git', 'config'), '[b]\n\thex = 0x10\n\tzero = 0x0\n\tspace = " 1"\n\thuge = 99999999999\n\tgig = 3g\n');
    for (const key of ['b.hex', 'b.zero', 'b.space', 'b.huge', 'b.gig']) {
      assert.equal(await new ConfigSnapshot(box.dir).getBoolConfig(key), await new Git(box.dir).getBoolConfig(key), key);
    }
  } finally {
    box.dispose();
  }
});

test('a scope with no config file at all reads as unset, as git --get does', async () => {
  const box = sandbox();
  const saved = { global: process.env['GIT_CONFIG_GLOBAL'], system: process.env['GIT_CONFIG_SYSTEM'] };
  try {
    process.env['GIT_CONFIG_GLOBAL'] = join(box.dir, '..', 'no-such-global');
    process.env['GIT_CONFIG_SYSTEM'] = join(box.dir, '..', 'no-such-system');
    for (const scope of ['global', 'system'] as const) {
      const snapshot = new ConfigSnapshot(box.dir);
      assert.deepEqual(await readAll(snapshot, 'user.name', scope), await readAll(new Git(box.dir), 'user.name', scope), scope);
      const asked = await new Asking(box.dir).ask(['config', '--' + scope, '--get', 'user.name']);
      assert.equal(asked.code, 1, 'not set (1), as --get says, never a failure (128)');
    }
  } finally {
    process.env['GIT_CONFIG_GLOBAL'] = saved.global;
    process.env['GIT_CONFIG_SYSTEM'] = saved.system;
    box.dispose();
  }
});

test('a value that looks like a query flag is still a write, and refused', async () => {
  const box = sandbox();
  try {
    const snapshot = new ConfigSnapshot(box.dir);
    for (const value of ['--list', '--show-origin', '--get-urlmatch']) await assert.rejects(snapshot.setConfig('a.b', value), /only reads/, value);
    assert.throws(() => box.git('config', '--local', '--get-all', 'a.b'), 'nothing was written');
  } finally {
    box.dispose();
  }
});

test('snapshotOf refuses a Git subclass instead of quietly dropping what it overrides', () => {
  class Fake extends Git {}
  assert.throws(() => snapshotOf(new Fake('.')), /plain Git/);
});

/** Sends one git call through a snapshot, to see the exit code a getter would see. */
class Asking extends ConfigSnapshot {
  ask(args: readonly string[]): Promise<ExecResult> {
    return this.exec(args);
  }
}

test('outside a repository the local scope fails the same way for both', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repown-norepo-'));
  try {
    for (const key of ['a.b', 'user.name']) {
      assert.deepEqual(await readAll(new ConfigSnapshot(dir), key, 'local'), await readAll(new Git(dir), key, 'local'), key);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
