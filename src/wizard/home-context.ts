// What the start screen reads before it asks: the registry, whether gh is git's
// credential helper, and the clones below this folder. Read-only. A directory
// it cannot list is skipped; `repown scan` is the command that reports those.

import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Git } from '../core/git.ts';
import { inspectAuth, inspectRepo, type RepoState } from '../core/inspect.ts';
import { planRepair } from '../core/credential/repair.ts';
import { loadRegistry, type Registry } from '../core/registry.ts';
import type { Result } from '../core/result.ts';
import { identityProblems } from '../commands/status.ts';
import { CONCURRENCY, discover, mapLimited } from '../commands/scan.ts';
import { signedInLogins } from './setup-flow.ts';

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
  /** Global user.name and user.email: shown beside a new account's, never filled in. */
  readonly identity: Identity;
}

export interface Identity {
  readonly name: string | null;
  readonly email: string | null;
}

/** Tests pass fakes. Production reads the machine. */
export interface HomeDeps {
  readonly registry?: () => Promise<Result<Registry>>;
  readonly ghIsHelper?: (cwd: string) => Promise<boolean>;
  readonly findClones?: (cwd: string) => Promise<readonly string[]>;
  readonly inspect?: (git: Git) => Promise<RepoState>;
  readonly identity?: (cwd: string) => Promise<Identity>;
}

export async function readHome(cwd: string, deps: HomeDeps = {}): Promise<HomeState> {
  const [registry, ghIsHelper, clones, identity] = await Promise.all([
    registryOf(deps), helperOf(cwd, deps), clonesOf(cwd, deps), (deps.identity ?? identityOf)(cwd),
  ]);
  return { cwd: resolve(cwd), registry, ghIsHelper, clones, identity };
}

/** Outside a clone, git's own lookup is the global (or system) value. */
async function identityOf(cwd: string): Promise<Identity> {
  const git = new Git(cwd);
  const [name, email] = await Promise.all([git.getConfig('user.name'), git.getConfig('user.email')]);
  return { name, email };
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
  const described = await mapLimited(found, CONCURRENCY, (dir) => describeClone(dir, deps));
  return described.filter(isClone);
}

async function findClones(cwd: string, deps: HomeDeps): Promise<readonly string[]> {
  if (deps.findClones) return deps.findClones(cwd);
  if (await new Git(cwd).isBare()) return [];
  return clonesWithin(cwd, HOME_DEPTH);
}

/**
 * Repositories at most `depth` levels down, counting a repository at `dir`.
 * Git accepting a directory stops the walk. Git refusing one is not a clone;
 * the levels still left are searched inside it. This folder is that rule at depth 0.
 */
async function clonesWithin(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const found = await search(dir, depth);
  const parts = await mapLimited(found, CONCURRENCY, (path) => keepOrEnter(dir, path, depth));
  return parts.flat();
}

async function keepOrEnter(searched: string, path: string, budget: number): Promise<string[]> {
  if (await new Git(path).isRepo()) return [path];
  return enterRefused(path, budget - levelsBelow(searched, path));
}

/** One of `remaining` is spent stepping into `dir`; what is left is searched below it. */
async function enterRefused(dir: string, remaining: number): Promise<string[]> {
  if (remaining <= 0) return [];
  const names = await childNames(dir);
  const nested = await mapLimited(names, CONCURRENCY, (name) => clonesWithin(join(dir, name), remaining - 1));
  return nested.flat();
}

function levelsBelow(root: string, path: string): number {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' ? 0 : rel.split(sep).length;
}

async function search(dir: string, depth: number): Promise<string[]> {
  const unreadable: string[] = [];
  const found = await discover({ root: dir, path: dir }, depth, unreadable, skipHomeEntry);
  return found.map((entry) => entry.path);
}

/** Child directories the start screen would enter. An unlistable folder is skipped. */
async function childNames(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !skipHomeEntry(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function describeClone(dir: string, deps: HomeDeps): Promise<HomeClone | null> {
  const inspect = deps.inspect ?? inspectRepo;
  const repo = await inspect(new Git(dir));
  if (!repo.isRepo) return null;
  return { path: resolve(dir), setUp: identityProblems(repo).length === 0 };
}

function isClone(clone: HomeClone | null): clone is HomeClone {
  return clone !== null;
}

/** Dot-directories, node_modules, and on Windows AppData. Only the start screen passes this. */
function skipHomeEntry(name: string): boolean {
  if (name.startsWith('.') || name === 'node_modules') return true;
  return process.platform === 'win32' && name.toLowerCase() === 'appdata';
}

/** The github.com logins gh and Git Credential Manager are signed in as; read only when Record an account asks. */
export async function readSignedIn(cwd: string): Promise<string[] | null> {
  const auth = await inspectAuth(new Git(cwd));
  return signedInLogins(auth.ghPresent ? auth.gh : null, auth.stored);
}
