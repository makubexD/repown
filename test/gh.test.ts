// The github.com profile lookup. `--hostname` keeps GH_HOST from sending it elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ghProfileArgs, ghLogin, ghLoginVersion, ghStateFrom, profileLookupFrom } from '../src/core/credential/gh.ts';
import { loginKindProblem } from '../src/core/hosts/index.ts';
import type { ExecResult } from '../src/core/exec.ts';
import { err } from '../src/core/result.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';

test('a github.com profile lookup names the host, so GH_HOST cannot redirect it', () => {
  assert.deepEqual(
    ghProfileArgs('octocat', 'type'),
    ['api', '--hostname', 'github.com', 'users/octocat', '--jq', '.type'],
  );
  assert.deepEqual(
    ghProfileArgs('octo-org', 'name'),
    ['api', '--hostname', 'github.com', 'users/octo-org', '--jq', '.name'],
  );
  const source = readFileSync(new URL('../src/core/credential/gh.ts', import.meta.url), 'utf8');
  assert.match(source, /run\('gh', ghProfileArgs\(login, field\)\)/);
});

test('exit 0 and {"hosts":{}} is nobody signed in, and so is a missing host or an empty list', () => {
  const nobody = { accounts: [], active: null };
  assert.deepEqual(ghStateFrom(status(GH_EMPTY_HOSTS)), { ok: true, value: nobody });
  const elsewhere = '{"hosts":{"git.example.invalid":[{"login":"octocat","active":true}]}}\n';
  assert.deepEqual(ghStateFrom(status(elsewhere)), { ok: true, value: nobody });
  assert.deepEqual(ghStateFrom(status('{"hosts":{"github.com":[]}}\n')), { ok: true, value: nobody });
  const coloured = '\x1b[1;37m{\x1b[m\n  \x1b[1;34m"hosts"\x1b[m\x1b[1;37m:\x1b[m \x1b[1;37m{\x1b[m\x1b[1;37m}\x1b[m\n\x1b[1;37m}\x1b[m\n';
  assert.deepEqual(ghStateFrom(status(coloured)), { ok: true, value: nobody });
});

test('a non-zero exit, a spawn error, or JSON of the wrong shape is a failed query', () => {
  assert.deepEqual(ghStateFrom(status(GH_EMPTY_HOSTS, 1)), err('gh auth status failed'));
  assert.deepEqual(ghStateFrom(status('', -1, enoent())), err('gh is not installed'));
  const denied = Object.assign(new Error('boom'), { code: 'EACCES' });
  assert.deepEqual(ghStateFrom(status('', -1, denied)), err('gh auth status failed'));
  for (const stdout of ['not json', '{"hosts":"nope"}', '{"hosts":{"github.com":{}}}', 'null', '[]', '{}']) {
    assert.deepEqual(ghStateFrom(status(stdout)), err('gh auth status returned nothing usable'), stdout);
  }
});

test('a listed account still parses, including which one is active', () => {
  const raw = '{"hosts":{"github.com":[{"login":"octocat","active":true},{"login":"octo-org","active":false}]}}\n';
  const parsed = ghStateFrom(status(raw));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.active, 'octocat');
  assert.deepEqual(parsed.value.accounts.map((account) => account.login), ['octocat', 'octo-org']);
});

function status(stdout: string, code = 0, spawnError?: NodeJS.ErrnoException): ExecResult {
  return { code, stdout, stderr: '', ...(spawnError ? { spawnError } : {}) };
}

test('gh before 2.40.0 must not log in; 2.40.0 may; an unreadable version is unknown', () => {
  assert.equal(ghLoginVersion('gh version 2.39.9 (2023-12-01)'), 'old');
  assert.equal(ghLoginVersion('gh version 2.40.0 (2023-12-07)'), 'ready');
  assert.equal(ghLoginVersion('gh version 2.88.1 (2026-03-12)'), 'ready');
  assert.equal(ghLoginVersion('not a version'), 'unknown');
  assert.equal(ghLoginVersion(''), 'unknown');
});

test('ghLogin asks for the browser flow and strips token variables from the child', async () => {
  const saved = stash(['GH_TOKEN', 'GITHUB_TOKEN', 'REPOWN_FAKE_MARKER']);
  process.env['GH_TOKEN'] = 'not-a-real-token';
  process.env['GITHUB_TOKEN'] = 'also-not-real';
  process.env['REPOWN_FAKE_MARKER'] = 'kept';
  const seen = fakeRunner(0);
  try {
    const result = await ghLogin('github.com', seen.runner);
    assert.equal(result.ok, true);
    assert.deepEqual(seen.call, {
      file: 'gh',
      args: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'],
    });
    assert.equal(seen.env?.['GH_TOKEN'], undefined);
    assert.equal(seen.env?.['GITHUB_TOKEN'], undefined);
    assert.equal(seen.env?.['REPOWN_FAKE_MARKER'], 'kept');
    assert.equal(process.env['GH_TOKEN'], 'not-a-real-token', 'the parent env is left alone');
  } finally {
    restore(saved);
  }
});

test('ghLogin maps exit 0, exit 2 and any other failure', async () => {
  assert.equal((await ghLogin('github.com', fakeRunner(0).runner)).ok, true);
  const cancelled = await ghLogin('github.com', fakeRunner(2).runner);
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.deepEqual(cancelled.error, { kind: 'cancelled' });
  const failed = await ghLogin('github.com', fakeRunner(1).runner);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.deepEqual(failed.error, { kind: 'failed', reason: 'gh auth login exited 1' });
  const missing = await ghLogin('github.com', fakeRunner(-1, enoent()).runner);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.error, { kind: 'failed', reason: 'gh is not installed' });
});

interface Seen {
  call?: { file: string; args: readonly string[] };
  env?: NodeJS.ProcessEnv;
  runner(file: string, args: readonly string[], options?: { readonly env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
}

function fakeRunner(code: number, spawnError?: NodeJS.ErrnoException): Seen {
  const seen: Seen = {
    runner: (file, args, options) => {
      seen.call = { file, args };
      if (options?.env !== undefined) seen.env = options.env;
      return Promise.resolve({ code, stdout: '', stderr: '', ...(spawnError ? { spawnError } : {}) });
    },
  };
  return seen;
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
}

function stash(names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('a profile lookup github.com answers with 404 is missing; any other failure is unknown, never missing', () => {
  const notFound = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)\n' };
  assert.deepEqual(profileLookupFrom(notFound), { value: null, missing: true });
  assert.deepEqual(profileLookupFrom(status('User\n')), { value: 'User', missing: false });
  assert.deepEqual(profileLookupFrom(status('null\n')), { value: null, missing: false });
  const offline = { code: 1, stdout: '', stderr: 'error connecting to api.github.com\n' };
  assert.deepEqual(profileLookupFrom(offline), { value: null, missing: false });
  const forbidden = { code: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)\n' };
  assert.deepEqual(profileLookupFrom(forbidden), { value: null, missing: false });
  assert.deepEqual(profileLookupFrom(status('', 0, Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))), { value: null, missing: false });
});

test('a login github.com has no account for, or an organisation, gets a sentence; a user or an unknown gets none', () => {
  assert.equal(loginKindProblem('missing', 'octocat'), 'github.com has no account named octocat: check the spelling');
  assert.equal(loginKindProblem('organization', 'octo-org'), 'octo-org is an organisation on github.com, not an account you sign in as');
  assert.equal(loginKindProblem('user', 'octocat'), null);
  assert.equal(loginKindProblem(null, 'octocat'), null);
  assert.equal(loginKindProblem(undefined, 'octocat'), null);
});
