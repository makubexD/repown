// A git repository with NO connection to this machine's real configuration.
//
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM (git >= 2.32) are what make these
// tests honest: without them a machine whose global config already sets
// credential.helper would pass the very assertions that are meant to detect it.
// REPOWN_CONFIG_DIR is the same idea for the account registry: an empty directory
// inside the sandbox, so a test never reads or writes this machine's accounts.

import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Sandbox {
  readonly dir: string;
  readonly globalConfig: string;
  git(...args: string[]): string;
  writeGlobalConfig(body: string): void;
  dispose(): void;
}

/**
 * Inherited from whatever ran `npm test` -- a hook, husky, a shell with an
 * identity exported -- and each one either redirects git to ANOTHER repository
 * (GIT_DIR pinned the developer's real clone as "Sandbox") or overrides the
 * identity under test. None may reach a sandbox.
 */
const LEAKY = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GH_TOKEN', 'GITHUB_TOKEN',
];

/**
 * Colour decisions inherited from the shell. Forced colour changes the text a
 * spawned command prints, so a sandbox and plainTerminal() clear these for as
 * long as they are in force and put the previous values back afterwards.
 */
const TERMINAL = [
  'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE', 'COLORTERM', 'TERM',
];

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'repown-test-'));
  const globalConfig = join(dir, 'gitconfig-global');
  const systemConfig = join(dir, 'gitconfig-system');
  writeFileSync(globalConfig, '');
  writeFileSync(systemConfig, '');
  const saved = isolate(dir, globalConfig, systemConfig);
  const work = join(dir, 'repo');
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
  initRepo(work);
  return {
    dir: work,
    globalConfig,
    git,
    writeGlobalConfig: (body) => writeFileSync(globalConfig, body),
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
      restore(saved);
    },
  };
}

function isolate(dir: string, globalConfig: string, systemConfig: string): Record<string, string | undefined> {
  const saved = snapshot([
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'REPOWN_CONFIG_DIR', 'GH_CONFIG_DIR', ...LEAKY, ...TERMINAL,
  ]);
  clear([...LEAKY, ...TERMINAL]);
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_SYSTEM'] = systemConfig;
  process.env['REPOWN_CONFIG_DIR'] = join(dir, 'repown-config');
  process.env['GH_CONFIG_DIR'] = join(dir, 'gh-config');
  return saved;
}

// The [user] block `git config --local` writes: a tab before each key, and LF.
const SANDBOX_USER = '[user]\n\tname = Sandbox\n\temail = sandbox@example.invalid\n';

function initRepo(work: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  appendFileSync(join(work, '.git', 'config'), SANDBOX_USER);
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export function plainTerminal(): () => void {
  const saved = snapshot(TERMINAL);
  clear(TERMINAL);
  return () => restore(saved);
}

function snapshot(names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function clear(names: readonly string[]): void {
  for (const name of names) delete process.env[name];
}

const GH_NAMES = ['gh', 'gh.exe', 'gh.cmd', 'gh.bat'];
const ghMirrors = new Map<string, string>();

/**
 * gh shares /usr/bin with git on Linux CI. Dropping that directory makes git
 * unreachable and every sandbox reads as "not a repository", so elsewhere the
 * directory is mirrored once per process with every entry except gh.
 */
export function pathWithoutGh(path = process.env['PATH'] ?? ''): string {
  return path.split(delimiter).flatMap(hideGhDir).join(delimiter);
}

function hideGhDir(dir: string): readonly string[] {
  if (dir === '' || !containsGh(dir)) return [dir];
  return process.platform === 'win32' ? [] : [mirrorWithoutGh(dir)];
}

function containsGh(dir: string): boolean {
  return GH_NAMES.some((name) => existsSync(join(dir, name)));
}

function mirrorWithoutGh(dir: string): string {
  const cached = ghMirrors.get(dir);
  if (cached !== undefined) return cached;
  const mirror = mkdtempSync(join(tmpdir(), 'repown-nogh-'));
  for (const name of readdirSync(dir)) linkExceptGh(dir, mirror, name);
  ghMirrors.set(dir, mirror);
  return mirror;
}

function linkExceptGh(dir: string, mirror: string, name: string): void {
  if (name === 'gh') return;
  try {
    symlinkSync(join(dir, name), join(mirror, name));
  } catch {
    // One entry that cannot be linked must not hide git.
  }
}
