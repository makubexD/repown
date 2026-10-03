// What the repown status test files share. Moved out of status.test.ts unchanged when it
// was split by suite so node --test can run the parts in parallel.

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
import { fakeExeDir } from './fake-exe.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export const TITLE = 'repown status · current settings of this clone';
plainTerminal();

export interface Run { readonly status: number; readonly stdout: string; readonly stderr: string; }

export function repown(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input: '', env, encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export const SETUP_FIX = '       fix: repown setup   (or: repown use <account>)';

export function accountLine(stdout: string): string {
  const found = stdout.split('\n').find((text) => text.startsWith('  account '));
  assert.ok(found, stdout);
  return found;
}

export function upstreamLine(stdout: string): string | undefined {
  return stdout.split('\n').find((text) => text.startsWith('  upstream '));
}

export function fieldLine(label: string, value: string): string {
  return '  ' + label.padEnd(14) + ' ' + value;
}

/** Git's work-tree path uses forward slashes. Shown paths use the platform's own. */
export function shownPath(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('/', '\\') : path;
}

export const GH_ACTIVE_NOTE = 'NOTE  gh         active as "octo-work", so `gh pr create` here would act as ' +
  'that account. git pushes are unaffected; this only matters if you use gh here.';

export function track(box: Sandbox, ref: string): void {
  box.git('commit', '--allow-empty', '-m', 'base');
  box.git('update-ref', 'refs/remotes/' + ref, 'HEAD');
  box.git('branch', '--set-upstream-to=' + ref);
}

export function record(box: Sandbox, account: string, name: string, email: string): void {
  const run = repown(['accounts', 'add', account, '--name', name, '--email', email], box.dir);
  assert.equal(run.status, 0, run.stderr);
}

export function breakRegistry(): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{');
}

export function fieldsUnder(stdout: string, heading: string): string[] {
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

export function pinGithub(box: Sandbox): void {
  box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
  box.git('config', '--local', 'user.name', 'Octo Cat');
  box.git('config', '--local', 'user.email', 'octocat@example.invalid');
  box.git('config', '--local', 'repown.account', 'octocat');
  box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
  box.git('config', '--local', 'credential.helper', 'manager');
}

export function unpin(box: Sandbox): void {
  box.git('config', '--local', '--unset', 'user.name');
  box.git('config', '--local', '--unset', 'user.email');
}

/** gh on PATH would add a machine-dependent warning; a clean count needs it absent. */
export function quietEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: pathWithoutGh() };
}

export function fakeGhEnv(box: Sandbox, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = join(box.dir, '..', 'fake-gh-bin');
  mkdirSync(bin, { recursive: true });
  installFakeGh(bin);
  const env = quietEnv();
  return { ...env, ...extra, PATH: fakeGhPath(bin) + delimiter + (env['PATH'] ?? '') };
}

/** On Windows the compiled fake stays where it was built (fakeExeDir); fakeGhPath puts it on PATH. */
export function installFakeGh(bin: string): void {
  if (process.platform !== 'win32') writeFileSync(join(bin, 'gh'), FAKE_GH_SH, { mode: 0o755 });
}

/** The PATH entries that find the fake gh first: its build folder on Windows, `bin` elsewhere. */
export function fakeGhPath(bin: string): string {
  return process.platform === 'win32' ? fakeExeDir('gh.exe', FAKE_GH_CS) + delimiter + bin : bin;
}

export const FAKE_GH_CS = `
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

export const FAKE_GH_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.88.1 (2026-03-12)"; exit 0; fi
if [ "$GH_FAKE_FAIL" = "1" ]; then exit 1; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"hosts":{"github.com":[{"login":"octo-work","active":true}]}}'
  exit 0
fi
exit 97
`;

export function guardOn(box: Sandbox): void {
  const run = repown(['guard', 'on'], box.dir);
  assert.equal(run.status, 0, run.stderr);
}

export function counted(stderr: string, word?: 'FAIL' | 'WARN'): number {
  const lines = stderr.split('\n');
  if (word === undefined) return lines.filter((line) => line.startsWith('FAIL  ') || line.startsWith('WARN  ')).length;
  return lines.filter((line) => line.startsWith(word + '  ')).length;
}

/** Problems plus warnings named by the closing tally. */
export function tallyCount(stderr: string): number {
  const line = closing(stderr)
    .replace(/^ready: commits and pushes use \S+ · /, '')
    .replace(/^ready: commits use \S+; pushes use this host's own sign-in · /, '')
    .replace(/: run repown setup$/, '');
  return [...line.matchAll(/(\d+) /g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

export function assertRegistryWarning(stderr: string): void {
  assert.ok(stderr.includes('WARN  account    the account registry could not be read, so this clone\'s account was not compared with it.'), stderr);
  assert.ok(stderr.includes('       see: repown accounts list'), stderr);
}

export function ghActive(login: string): AuthState {
  return ghAccounts(login, [login]);
}

export function ghAccounts(active: string, logins: readonly string[]): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: ok({
      accounts: logins.map((login) => ({ login, active: login === active })),
      active,
    }),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

export function ghUnverified(): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), ghPresent: true,
    gh: err('gh auth status failed'),
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}

/** The last stderr line, which must stand after a blank line. */
export function closing(stderr: string): string {
  const lines = stderr.split('\n');
  assert.equal(lines.at(-1), '', stderr);
  assert.equal(lines.at(-3), '', stderr);
  return lines.at(-2) ?? '';
}

export function notARepo(dir: string): string {
  return 'FAIL  repown     Not a git repository: ' + dir + '\n' +
    '       repown pins an identity per clone, so it needs one to work in.\n';
}

export function restoreCeiling(saved: string | undefined): void {
  if (saved === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = saved;
}
