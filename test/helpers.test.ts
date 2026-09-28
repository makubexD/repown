// pathWithoutGh must hide gh without taking git with it. On Linux CI both live
// in /usr/bin; these stand in for that directory on whatever platform runs them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathWithoutGh } from './helpers.ts';

test('pathWithoutGh keeps git reachable when gh shares its directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'repown-pathgh-'));
  const shared = join(root, 'shared');
  const plain = join(root, 'plain');
  mkdirSync(shared);
  mkdirSync(plain);
  writeFileSync(join(shared, 'gh'), '');
  writeFileSync(join(shared, 'git'), '');
  writeFileSync(join(plain, 'git'), '');
  try {
    const result = pathWithoutGh([plain, shared].join(delimiter));
    assert.equal(resolves(result, 'git'), true);
    assert.equal(resolves(result, 'gh'), false);
    assertKept(result, shared, plain);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function resolves(path: string, name: string): boolean {
  return path.split(delimiter).some((dir) => dir !== '' && existsSync(join(dir, name)));
}

function assertKept(result: string, shared: string, plain: string): void {
  const dirs = result.split(delimiter);
  if (process.platform === 'win32') {
    assert.deepEqual(dirs, [plain]);
    return;
  }
  const mirror = dirs[1] ?? '';
  assert.equal(dirs[0], plain);
  assert.notEqual(mirror, shared);
  assert.equal(existsSync(join(mirror, 'git')), true);
  assert.equal(existsSync(join(mirror, 'gh')), false);
  assert.equal(pathWithoutGh([plain, shared].join(delimiter)).split(delimiter)[1], mirror);
}
