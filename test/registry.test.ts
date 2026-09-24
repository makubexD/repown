// The account registry holds real names and addresses, recorded once per
// machine. A read failure must never be mistaken for "no accounts", because the
// next write would then replace the whole file with one entry.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, lookupAccount, saveAccount, removeAccount, registryPath } from '../src/core/registry.ts';

const OCTOCAT = { name: 'Octo Cat', email: 'octocat@example.invalid' };

describe('the account registry', () => {
  let dir: string;
  const saved = process.env['REPOWN_CONFIG_DIR'];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'repown-registry-')); process.env['REPOWN_CONFIG_DIR'] = dir; });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env['REPOWN_CONFIG_DIR']; else process.env['REPOWN_CONFIG_DIR'] = saved;
  });

  test('no file yet is an empty registry, not an error', async () => {
    const registry = await loadRegistry();
    assert.ok(registry.ok);
    assert.deepEqual(Object.keys(registry.value.accounts), []);
  });

  test('a file that does not parse is an ERROR, and a save refuses to overwrite it', async () => {
    const broken = '{ "accounts": { "octocat": { "name": "Octo Cat", }, } }';
    writeFileSync(registryPath(), broken);
    assert.equal((await loadRegistry()).ok, false);
    const written = await saveAccount('other', OCTOCAT);
    assert.equal(written.ok, false);
    assert.equal(readFileSync(registryPath(), 'utf8'), broken, 'every other account would have been lost');
  });

  test('an account name like "constructor" is not found on the object prototype', async () => {
    await saveAccount('octocat', OCTOCAT);
    const found = await lookupAccount('constructor');
    assert.ok(found.ok);
    assert.equal(found.value, null);
    const removed = await removeAccount('toString');
    assert.ok(removed.ok);
    assert.equal(removed.value, false, 'nothing was recorded under that name');
  });

  test('an entry without string name and email is not treated as an account', async () => {
    writeFileSync(registryPath(), JSON.stringify({ accounts: { bad: { name: 'x', email: 7 }, octocat: OCTOCAT } }));
    const registry = await loadRegistry();
    assert.ok(registry.ok);
    assert.deepEqual(Object.keys(registry.value.accounts), ['octocat']);
  });

  test('the file is readable by its owner only', { skip: process.platform === 'win32' }, async () => {
    await saveAccount('octocat', OCTOCAT);
    assert.equal(statSync(registryPath()).mode & 0o777, 0o600);
  });
});
