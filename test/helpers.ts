// A git repository with NO connection to this machine's real configuration.
//
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM (git >= 2.32) are what make these
// tests honest: without them a machine whose global config already sets
// credential.helper would pass the very assertions that are meant to detect it.
// REPOWN_CONFIG_DIR is the same idea for the account registry: an empty directory
// inside the sandbox, so a test never reads or writes this machine's accounts.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  initRepo(work, git);
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
  const saved = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'REPOWN_CONFIG_DIR', 'GH_CONFIG_DIR', ...LEAKY]
    .map((name) => [name, process.env[name]]));
  for (const name of LEAKY) delete process.env[name];
  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_SYSTEM'] = systemConfig;
  process.env['REPOWN_CONFIG_DIR'] = join(dir, 'repown-config');
  process.env['GH_CONFIG_DIR'] = join(dir, 'gh-config');
  return saved;
}

function initRepo(work: string, git: (...args: string[]) => string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  git('config', '--local', 'user.name', 'Sandbox');
  git('config', '--local', 'user.email', 'sandbox@example.invalid');
}

function restore(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
