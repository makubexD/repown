// What the start screen reads before it asks: the registry, whether gh is git's
// credential helper, and the clones below this folder. Read-only. A directory
// it cannot list is skipped; `repown scan` is the command that reports those.

import { resolve } from 'node:path';
import { Git } from '../core/git.ts';
import { inspectRepo, type RepoState } from '../core/inspect.ts';
import { planRepair } from '../core/credential/repair.ts';
import { loadRegistry, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import { identityProblems } from '../commands/status.ts';
import { CONCURRENCY, discover, mapLimited } from '../commands/scan.ts';

/** How many levels below this folder the start screen looks. `repown scan` looks further. */
export const HOME_DEPTH = 2;

export interface HomeClone {
  readonly path: string;
  readonly setUp: boolean;
}

export interface HomeState {
  readonly cwd: string;
  readonly registry: Result<Registry>;
  readonly ghIsHelper: boolean;
  readonly clones: readonly HomeClone[];
}

/** Tests pass fakes. Production reads the machine. */
export interface HomeDeps {
  readonly registry?: () => Promise<Result<Registry>>;
  readonly ghIsHelper?: (cwd: string) => Promise<boolean>;
  readonly findClones?: (cwd: string) => Promise<readonly string[]>;
  readonly inspect?: (git: Git) => Promise<RepoState>;
}

export async function readHome(cwd: string, deps: HomeDeps = {}): Promise<HomeState> {
  const [registry, ghIsHelper, clones] = await Promise.all([
    registryOf(deps), helperOf(cwd, deps), clonesOf(cwd, deps),
  ]);
  return { cwd: resolve(cwd), registry, ghIsHelper, clones };
}

function registryOf(deps: HomeDeps): Promise<Result<Registry>> {
  return deps.registry ? deps.registry() : loadRegistry();
}

/** The same question `repown fix` previews: gh's helper entries are there to remove. */
function helperOf(cwd: string, deps: HomeDeps): Promise<boolean> {
  return deps.ghIsHelper ? deps.ghIsHelper(cwd) : ghHelper(cwd);
}

async function ghHelper(cwd: string): Promise<boolean> {
  return (await planRepair(new Git(cwd))).length > 0;
}

async function clonesOf(cwd: string, deps: HomeDeps): Promise<HomeClone[]> {
  const found = await findClones(cwd, deps);
  return mapLimited(found, CONCURRENCY, (dir) => describeClone(dir, deps));
}

async function findClones(cwd: string, deps: HomeDeps): Promise<readonly string[]> {
  if (deps.findClones) return deps.findClones(cwd);
  const unreadable: string[] = [];
  const found = await discover({ root: cwd, path: cwd }, HOME_DEPTH, unreadable, skipHomeEntry);
  return found.map((entry) => entry.path);
}

async function describeClone(dir: string, deps: HomeDeps): Promise<HomeClone> {
  const inspect = deps.inspect ?? inspectRepo;
  const repo = await inspect(new Git(dir));
  return { path: resolve(dir), setUp: identityProblems(repo).length === 0 };
}

/** Dot-directories, node_modules, and on Windows AppData. Only the start screen passes this. */
function skipHomeEntry(name: string): boolean {
  if (name.startsWith('.') || name === 'node_modules') return true;
  return process.platform === 'win32' && name.toLowerCase() === 'appdata';
}
