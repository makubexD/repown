// Finding Git Credential Manager, and asking it which accounts it holds.
//
// RESOLVED BY LOCATION, NOT BY BARE NAME, AND THAT IS LOAD-BEARING.
//
// On Windows GCM ships INSIDE Git's own directory -- Git Bash puts that on PATH
// and nothing else does. Verified again on this machine today:
// `git-credential-manager` does not resolve on the PowerShell or cmd PATH, while
// GCM is installed and is holding credentials for two accounts.
//
// A tool that decides "GCM is not installed" from a PATH lookup therefore refuses
// to run its own repair on exactly the machine that needs it. That false negative
// cost a debugging session in the implementation this replaces; it is ported
// deliberately rather than rediscovered.

import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { run, succeeded, lines, notInstalled } from '../exec.ts';
import { ok, err, type Result } from '../result.ts';

const NAMES = ['git-credential-manager', 'git-credential-manager-core'];

/** Directories that hold GCM but are not necessarily on PATH. */
async function searchDirectories(): Promise<string[]> {
  const directories: string[] = [];

  // Git for Windows bundles GCM as a sibling of git's own exec-path:
  //   <root>/mingw64/libexec/git-core  ->  <root>/mingw64/bin
  const execPath = await run('git', ['--exec-path']);
  if (succeeded(execPath)) {
    const mingw = dirname(dirname(execPath.stdout.trim()));
    if (mingw) directories.push(join(mingw, 'bin'));
  }

  // Where the standalone GCM installer puts it.
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData) {
    directories.push(join(localAppData, 'Programs', 'Git Credential Manager'));
  }
  return directories;
}

/**
 * Whether a credential.helper value is GCM. Git for Windows writes `manager`
 * (once `manager-core`); the macOS and Linux installers write the executable's
 * path. Matched on the last path component, so a path form is not reported as
 * "a helper repown has no opinion about".
 */
export function isGcm(helper: string | null): boolean {
  if (helper === null) return false;
  const base = helper.trim().split(/[\\/]/).pop() ?? '';
  return /^(git-credential-)?manager(-core)?(\.exe)?$/i.test(base);
}

/** The GCM executable, or null. Checks PATH first, then the known locations. */
export async function findGcm(): Promise<string | null> {
  for (const name of NAMES) {
    const probe = await run(name, ['--version']);
    if (!notInstalled(probe)) return name;
  }
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  for (const directory of await searchDirectories()) {
    for (const name of NAMES) {
      for (const suffix of suffixes) {
        const candidate = join(directory, name + suffix);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * The accounts GCM stores for `namespace` ('github', 'azure-repos', ...).
 *
 * An error result means GCM could not be ASKED, which is not the same as it
 * holding nothing -- callers must keep the two apart or a failed lookup reads as
 * a clean machine.
 */
export async function listAccounts(
  gcmPath: string | null,
  namespace: string,
): Promise<Result<string[]>> {
  if (!gcmPath) return err('Git Credential Manager is not installed');
  const result = await run(gcmPath, [namespace, 'list']);
  if (!succeeded(result)) {
    return err(`\`${namespace} list\` failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return ok(lines(result));
}
