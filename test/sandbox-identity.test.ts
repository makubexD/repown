// sandbox() pins user.name and user.email by appending [user] to .git/config.
// git must parse that section, and a commit made in the sandbox must carry it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const NAME = 'Sandbox';
const EMAIL = 'sandbox@example.invalid';
const USER_BLOCK = `[user]\n\tname = ${NAME}\n\temail = ${EMAIL}\n`;

test('a fresh sandbox has the pinned identity, in config text and on a commit', () => {
  const box = sandbox();
  try {
    assertGitIdentity(box);
    assertCommitAuthor(box);
    assertUserBlock(box);
  } finally {
    box.dispose();
  }
});

test('helpers does not spawn git config to write the sandbox identity', () => {
  const body = initRepoSource(readFileSync(new URL('./helpers.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(body, /git\(\s*'config',\s*'--local',\s*'user\.name'/);
  assert.doesNotMatch(body, /git\(\s*'config',\s*'--local',\s*'user\.email'/);
});

function initRepoSource(source: string): string {
  const start = source.indexOf('function initRepo');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.notEqual(start, -1);
  return source.slice(start, end === -1 ? undefined : end);
}

function assertGitIdentity(box: Sandbox): void {
  assert.equal(box.git('config', '--local', '--get', 'user.name'), NAME);
  assert.equal(box.git('config', '--local', '--get', 'user.email'), EMAIL);
}

function assertCommitAuthor(box: Sandbox): void {
  box.git('commit', '--allow-empty', '-m', 'identity');
  assert.equal(box.git('log', '-1', '--format=%an'), NAME);
  assert.equal(box.git('log', '-1', '--format=%ae'), EMAIL);
}

function assertUserBlock(box: Sandbox): void {
  const text = readFileSync(join(box.dir, '.git', 'config'), 'utf8');
  assert.ok(text.includes(USER_BLOCK));
}
