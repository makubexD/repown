// A command repown prints to copy must paste and run the same in the popular shells:
// sh, bash, dash, zsh and fish, PowerShell 7 and Windows PowerShell, and cmd. Each shell
// found here runs the printed line against a probe installed the way npm installs repown
// (a `repown` script, `repown.cmd`, `repown.ps1`), and the probe's argv must come back as
// the words repown meant. A shell this machine lacks is skipped, never passed: CI runs
// the file on Linux, macOS and Windows, so each shell is measured somewhere.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { allowOwnerCommand, copyableCommand, shellWord } from '../src/core/guard/check.ts';
import { formatCommand } from '../src/wizard/setup-flow.ts';

/** Bare, or in double quotes: every shell reads these back unchanged. */
const PORTABLE = [
  'octocat', '1234+octocat@users.noreply.github.com', 'https://github.com/octo-org/x.git',
  '0x10', '1kb', '-dash', '-a.b', '-a:b', 'Octo Cat', 'Conan O\'Brien', 'Conan O\u2019Brien', 'Jos\u00e9 N\u00fa\u00f1ez',
  'C:\\Work Dir\\x', 'a&b|c<d>e', '@octo', 'semi;colon', '*glob*', '~home', '{a,b}', '#hash', '(paren)', 'a=b',
];

/**
 * No quoting keeps these literal in every shell: single quotes are no quotes in cmd, and
 * PowerShell reads POSIX's '\'' as the end of the string, so the rest would run as code.
 */
const UNQUOTABLE = ['a$b', 'tick`', 'say "hi"', '100%', 'hi!', 'x\\', 'a\\\\b', 'Octo \u201cCat\u201d', '',
  'line\nbreak', 'x$\';Write-Output PWNED;#', 'x$&echo PWNED&'];

describe('shellWord', () => {
  test('words every shell reads as typed stay bare', () => {
    for (const word of ['octocat', '1234+octocat@users.noreply.github.com', 'https://x.example.invalid/a/b.git', '-dash', '--email', './x', '0x10']) {
      assert.equal(shellWord(word), word);
    }
  });

  test('anything else is double-quoted when the quotes keep it literal everywhere', () => {
    assert.equal(shellWord('Octo Cat'), '"Octo Cat"');
    assert.equal(shellWord('Conan O\'Brien'), '"Conan O\'Brien"');
    assert.equal(shellWord('C:\\Work Dir\\x'), '"C:\\Work Dir\\x"');
    assert.equal(shellWord('@octo'), '"@octo"', 'a leading @ is a PowerShell splat');
    assert.equal(shellWord('a=b'), '"a=b"');
    assert.equal(shellWord('-a.b'), '"-a.b"', 'PowerShell splits a dashed word at . or :');
    assert.equal(shellWord('--'), '"--"', 'PowerShell drops a bare -- from the $args of repown.ps1');
  });

  test('a word no quoting keeps literal in every shell is null, and a command holding one is not printed', () => {
    for (const word of UNQUOTABLE) assert.equal(shellWord(word), null, JSON.stringify(word));
    assert.equal(copyableCommand(['git', 'fetch', 'origin']), 'git fetch origin');
    assert.equal(copyableCommand(['git', 'fetch', 'x$&echo PWNED&']), null);
  });

  test('the allow-owner advice is a command only for an owner it can print as it is', () => {
    assert.equal(allowOwnerCommand('octo-org'), 'git config --local --add repown.allowOwner octo-org');
    assert.equal(allowOwnerCommand('x; curl evil'), 'git config --local --add repown.allowOwner "x; curl evil"');
    assert.equal(allowOwnerCommand('x$\';Write-Output PWNED;#'), null);
    assert.equal(allowOwnerCommand('-h'), null, 'git would read it as an option');
    assert.equal(allowOwnerCommand('octo\u202eorg'), null, 'a bidi control would show another owner than the one allowed');
  });
});

describe('formatCommand', () => {
  test('a `--` before a dashed account is quoted, since PowerShell drops a bare one from a script\'s $args', () => {
    assert.equal(formatCommand(['accounts', 'add', '--name=Octo Cat', '--email=o@example.invalid', '--', '-dash']),
      'repown accounts add --name "Octo Cat" --email o@example.invalid "--" -dash');
  });
});

interface Shell {
  readonly name: string;
  /** Runs one line in this shell with `bin` first on PATH; null when the shell isn't here. */
  run(line: string, bin: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } | null;
}

describe('pasting a printed command', () => {
  let root: string;
  before(() => { root = mkdtempSync(join(tmpdir(), 'repown-paste-')); installProbes(root); });
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const shell of shells()) {
    test(shell.name + ' reads every word repown prints for it', (t) => {
      const words = PORTABLE;
      const ran = shell.run('repown ' + words.map((word) => shellWord(word)).join(' '), join(root, binFor(shell.name)));
      if (ran === null) { t.skip(shell.name + ' is not installed here'); return; }
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(JSON.parse(ran.stdout.trim()), words);
    });

    test(shell.name + ' keeps the `--` before a dashed account', (t) => {
      const line = formatCommand(['accounts', 'remove', '--', '-dash']);
      const ran = shell.run(line, join(root, binFor(shell.name)));
      if (ran === null) { t.skip(shell.name + ' is not installed here'); return; }
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(JSON.parse(ran.stdout.trim()), ['accounts', 'remove', '--', '-dash']);
    });
  }
});

const PROBE = 'process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\\u0080-\\uffff]/g, ' +
  '(c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));\n';

/** One folder per kind of shim, so each shell finds the one npm would give it. */
function installProbes(root: string): void {
  writeFileSync(join(root, 'probe.cjs'), PROBE);
  for (const bin of ['posix', 'cmd', 'ps']) mkdirSync(join(root, bin));
  const posix = join(root, 'posix', 'repown');
  writeFileSync(posix, '#!/bin/sh\nexec node "$(dirname "$0")/../probe.cjs" "$@"\n');
  chmodSync(posix, 0o755);
  writeFileSync(join(root, 'cmd', 'repown.cmd'), '@ECHO off\r\nnode "%~dp0..\\probe.cjs" %*\r\n');
  writeFileSync(join(root, 'ps', 'repown.ps1'), '& node "$PSScriptRoot/../probe.cjs" $args\nexit $LASTEXITCODE\n');
}

function binFor(shell: string): string {
  if (shell === 'cmd') return 'cmd';
  return shell === 'pwsh' || shell === 'powershell' ? 'ps' : 'posix';
}

function shells(): Shell[] {
  const posix = (name: string, exe: string | null): Shell => ({
    name,
    run: (line, bin) => (exe ? present(exe, ['-c', line], bin) : null),
  });
  const powershell = (name: string): Shell => ({
    name,
    run: (line, bin) => present(name, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(line, 'utf16le').toString('base64')], bin),
  });
  return [
    posix('sh', 'sh'), posix('bash', bashPath()), posix('dash', 'dash'), posix('zsh', 'zsh'), posix('fish', 'fish'),
    powershell('pwsh'), powershell('powershell'),
    { name: 'cmd', run: (line, bin) => cmdRun(line, bin) },
  ];
}

/** Git for Windows' bash, found next to git; elsewhere the one on PATH. */
function bashPath(): string {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  return exec.status === 0 ? resolve(exec.stdout.trim(), '..', '..', '..', 'bin', 'bash.exe') : 'bash';
}

function cmdRun(line: string, bin: string): ReturnType<Shell['run']> {
  if (process.platform !== 'win32') return null;
  return present('cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], bin, true);
}

/** Null when the shell can't be started here (not installed, or a stub that exits at once). */
function present(exe: string, args: readonly string[], bin: string, verbatim = false): ReturnType<Shell['run']> {
  const env = { ...process.env, PATH: bin + delimiter + dirname(process.execPath) + delimiter + (process.env['PATH'] ?? '') };
  const ran = spawnSync(exe, args, { env, encoding: 'utf8', windowsVerbatimArguments: verbatim, timeout: 60_000 });
  if (ran.error) return null;
  if (ran.status !== 0 && !runs(exe)) return null;
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/** A shell that failed is missing only when it can't run a bare `exit 0` either (the WSL bash stub). */
function runs(exe: string): boolean {
  const probe = spawnSync(exe, exe.startsWith('cmd') ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'], { timeout: 60_000 });
  return !probe.error && probe.status === 0;
}
