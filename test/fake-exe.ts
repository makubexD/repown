// Windows tests compile gh.exe and git-credential-manager.exe with csc.
// Each (name, source) pair is built once per process. node --test gives
// every file its own process, so a module-level map needs no lock.
// Callers copy the binary into a per-test directory; behaviour stays per test.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export type CompileFake = (source: string, outFile: string) => void;

const built = new Map<string, string>();
let root: string | undefined;

export function compileFakeExe(name: string, source: string, compile: CompileFake = compileWithCsc): string {
  const key = name + '\0' + source;
  const hit = built.get(key);
  if (hit !== undefined) return hit;
  const out = build(name, source, compile);
  built.set(key, out);
  return out;
}

/**
 * The folder a fake .exe was compiled into, once per test process and outside every
 * sandbox. Tests put it on PATH instead of copying the .exe into a sandbox: Windows
 * (Defender scanning a new executable) could keep that copy locked for seconds, so the
 * sandbox couldn't be deleted (EPERM) when the machine was busy.
 */
export function fakeExeDir(name: string, source: string): string {
  return dirname(compileFakeExe(name, source));
}

function build(name: string, source: string, compile: CompileFake): string {
  const dir = mkdtempSync(join(cacheDir(), 'bin-'));
  const out = join(dir, name);
  compile(source, out);
  return out;
}

function cacheDir(): string {
  if (root !== undefined) return root;
  root = mkdtempSync(join(tmpdir(), 'repown-fake-exe-'));
  return root;
}

function compileWithCsc(source: string, outFile: string): void {
  const file = outFile.replace(/\.exe$/, '.cs');
  writeFileSync(file, source);
  const run = spawnSync(cscPath(), ['/nologo', '/out:' + outFile, file], { encoding: 'utf8' });
  if (run.status === 0) return;
  const detail = (run.stdout ?? '') + (run.stderr ?? '');
  throw new Error('csc failed for ' + outFile + '\n' + detail, { cause: run.error });
}

function cscPath(): string {
  const base = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET');
  const found = ['Framework64', 'Framework']
    .map((edition) => join(base, edition, 'v4.0.30319', 'csc.exe'))
    .find((path) => existsSync(path));
  if (found !== undefined) return found;
  throw new Error('csc.exe is not installed');
}

function removeCache(): void {
  if (root === undefined) return;
  rmSync(root, { recursive: true, force: true });
}

process.on('exit', removeCache);
