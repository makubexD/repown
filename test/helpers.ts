// A git repository with NO connection to this machine's real configuration.
//
// GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM (git >= 2.32) are what make these
// tests honest: without them a machine whose global config already sets
// credential.helper would pass the very assertions that are meant to detect it.

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

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'gid-test-'));
  const globalConfig = join(dir, 'gitconfig-global');
  const systemConfig = join(dir, 'gitconfig-system');
  writeFileSync(globalConfig, '');
  writeFileSync(systemConfig, '');

  process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
  process.env['GIT_CONFIG_SYSTEM'] = systemConfig;

  const work = join(dir, 'repo');
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();

  execFileSync('git', ['init', '-q', '-b', 'main', work], { encoding: 'utf8' });
  git('config', '--local', 'user.name', 'Sandbox');
  git('config', '--local', 'user.email', 'sandbox@example.invalid');

  return {
    dir: work,
    globalConfig,
    git,
    writeGlobalConfig: (body) => writeFileSync(globalConfig, body),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
