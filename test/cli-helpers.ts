// What the CLI test files share: the real entry point and how to run it. Moved out of
// cli.test.ts unchanged when it was split by suite so node --test can run the parts in parallel.

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathWithoutGh, plainTerminal, sandbox, type Sandbox } from './helpers.ts';
import { fakeExeDir } from './fake-exe.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';
import { runProgram, type DefaultChoice, type Loader, type Program } from '../src/ui/dispatch.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

plainTerminal();

// Assertions read plain text. A shell that exports FORCE_COLOR (some terminals and
// CI runners do) would otherwise colour every spawned run's output.
export interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function repown(args: readonly string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    input: options.input ?? '',
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function fakeProgram(choose: (() => Promise<DefaultChoice>) | undefined, ran: string[]): Program {
  const load = (name: string): Loader => async () => ({
    summary: name,
    run: async () => { ran.push(name); return 0; },
  });
  return {
    name: 'tool',
    commands: { status: load('status'), setup: load('setup') },
    defaultCommand: 'status',
    ...(choose ? { chooseDefault: choose } : {}),
    topHelp: () => ['TOP HELP'],
  };
}

// repown runs gh calls in parallel (inspectAuth), and File.AppendAllText locks
// the log: a second writer threw, exited non-zero, and read as "gh could not be
// queried" (CI saw `gh auth switch exited 97`). The mutex serializes the writes.
export const FAKE_GH_CS = `
using System;
using System.IO;
using System.Threading;
class FakeGh {
  static void Append(string path, string line) {
    using (var gate = new Mutex(false, "repown-fake-gh-log")) {
      gate.WaitOne();
      try { File.AppendAllText(path, line); }
      finally { gate.ReleaseMutex(); }
    }
  }
  static int Main(string[] args) {
    var log = Environment.GetEnvironmentVariable("GH_FAKE_LOG");
    if (!string.IsNullOrEmpty(log)) Append(log, string.Join(" ", args) + "\\n");
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("gh version 2.88.1 (2026-03-12)");
      Console.WriteLine("repown-fake-gh");
      return 0;
    }
    if (args.Length >= 2 && args[0] == "auth" && args[1] == "status") {
      var file = Environment.GetEnvironmentVariable("GH_FAKE_STATUS_FILE");
      if (!string.IsNullOrEmpty(file)) {
        Console.Write(File.ReadAllText(file));
        return 0;
      }
      Console.WriteLine("{\\"hosts\\":{\\"github.com\\":[{\\"login\\":\\"octo-work\\",\\"active\\":true}]}}");
      return 0;
    }
    return 97;
  }
}
`;

export const FAKE_GH_SH = `#!/bin/sh
if [ -n "$GH_FAKE_LOG" ]; then printf '%s\\n' "$*" >> "$GH_FAKE_LOG"; fi
if [ "$1" = "--version" ]; then
  echo "gh version 2.88.1 (2026-03-12)"
  echo "repown-fake-gh"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$GH_FAKE_STATUS_FILE" ]; then cat "$GH_FAKE_STATUS_FILE"; exit 0; fi
  echo '{"hosts":{"github.com":[{"login":"octo-work","active":true}]}}'
  exit 0
fi
exit 97
`;

export function ghEnv(bin: string, log: string): NodeJS.ProcessEnv {
  return { ...process.env, GH_FAKE_LOG: log, PATH: fakeGhPath(bin) + delimiter + pathWithoutGh() };
}

export function recordOctocat(box: Sandbox): void {
  const dir = join(box.dir, '..', 'repown-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
    accounts: { octocat: { name: 'Octo Cat', email: 'octocat@example.invalid' } },
  }));
}

/** On Windows the compiled fake stays where it was built (fakeExeDir); fakeGhPath puts it on PATH. */
export function installFakeGh(bin: string): void {
  if (process.platform !== 'win32') writeFileSync(join(bin, 'gh'), FAKE_GH_SH, { mode: 0o755 });
}

/** The PATH entries that find the fake gh first: its build folder on Windows, `bin` elsewhere. */
export function fakeGhPath(bin: string): string {
  return process.platform === 'win32' ? fakeExeDir('gh.exe', FAKE_GH_CS) + delimiter + bin : bin;
}

export async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    return { code: await run(), out: chunks.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
