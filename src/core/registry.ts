// The per-machine account registry: name and email per account, recorded once.
//
// THIS IS WHAT MAKES `repown use <account>` A ONE-WORD COMMAND. Without it, pinning
// a clone means looking the name up from the host API and then asking the user,
// every time, in every repository. With it that happens once per machine and
// every clone afterwards is instant and non-interactive -- as short as
// `gh auth switch`, without being the global mode-switch that caused the problem
// this tool exists to solve.
//
// IT LIVES OUTSIDE EVERY REPOSITORY, AND THAT IS NOT NEGOTIABLE. It holds real
// names and real addresses. A repository may be public, may be forked, mirrored
// and scraped, and anything committed to one is published permanently. So the
// identifiers live here and the repository gets only what git already stores in
// .git/config, which git never tracks.

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ok, err, type Result } from './result.ts';

export interface Account {
  readonly name: string;
  readonly email: string;
  /** Provider id this account belongs to, when it is host-specific. */
  readonly host?: string;
}

export interface Registry {
  readonly accounts: Readonly<Record<string, Account>>;
  /** Entries present in the file but not readable as an account. Nothing may overwrite them. */
  readonly unreadable: readonly string[];
}

const EMPTY: Registry = { accounts: {}, unreadable: [] };

export function configDirectory(): string {
  const explicit = process.env['REPOWN_CONFIG_DIR'];
  if (explicit) return explicit;

  if (process.platform === 'win32' && process.env['APPDATA']) {
    return join(process.env['APPDATA'], 'repown');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg ? join(xdg, 'repown') : join(homedir(), '.config', 'repown');
}

export function registryPath(): string {
  return join(configDirectory(), 'accounts.json');
}

/**
 * No file yet is an EMPTY registry. Anything else that fails is an error --
 * reading a broken file as empty made the next save replace it, and every
 * account in it, with a single entry.
 */
export async function loadRegistry(): Promise<Result<Registry>> {
  let raw: string;
  try {
    raw = await readFile(registryPath(), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return ok(EMPTY);
    return err('could not read ' + registryPath() + ': ' + (cause as Error).message);
  }
  try {
    return ok(readAccounts((JSON.parse(raw) as { accounts?: unknown }).accounts));
  } catch (cause) {
    return err(registryPath() + ' is not valid JSON (' + (cause as Error).message +
               ') -- fix it or remove it; repown will not overwrite it');
  }
}

/** Entries with a string name and email, in an object with no prototype to collide with. */
function readAccounts(value: unknown): Registry {
  const accounts = Object.create(null) as Record<string, Account>;
  const unreadable: string[] = [];
  if (typeof value !== 'object' || value === null) return { accounts, unreadable };
  for (const [key, entry] of Object.entries(value)) {
    const { name, email, host } = (entry ?? {}) as Partial<Account>;
    if (typeof name !== 'string' || typeof email !== 'string') { unreadable.push(key); continue; }
    accounts[key] = typeof host === 'string' ? { name, email, host } : { name, email };
  }
  return { accounts, unreadable };
}

/** The registry, but only if a write would keep every entry in it. */
async function loadForWrite(): Promise<Result<Registry>> {
  const registry = await loadRegistry();
  if (!registry.ok || registry.value.unreadable.length === 0) return registry;
  return err(registryPath() + ' has entries repown cannot read (' + registry.value.unreadable.join(', ') +
             ') -- saving would drop them; fix or remove them first');
}

export async function lookupAccount(account: string): Promise<Result<Account | null>> {
  const registry = await loadRegistry();
  if (!registry.ok) return registry;
  return ok(Object.hasOwn(registry.value.accounts, account) ? registry.value.accounts[account]! : null);
}

export async function saveAccount(account: string, entry: Account): Promise<Result<void>> {
  const registry = await loadForWrite();
  if (!registry.ok) return registry;
  return write({ ...registry.value.accounts, [account]: entry });
}

export async function removeAccount(account: string): Promise<Result<boolean>> {
  const registry = await loadForWrite();
  if (!registry.ok) return registry;
  if (!Object.hasOwn(registry.value.accounts, account)) return ok(false);

  const accounts = { ...registry.value.accounts };
  delete accounts[account];
  const written = await write(accounts);
  return written.ok ? ok(true) : err(written.error);
}

/**
 * Written via a temporary file and renamed, so an interrupted write cannot
 * truncate it. Owner-only, since it holds names and addresses -- and a
 * leftover temporary file is removed first, because `mode` applies only when
 * the file is created, and rename would carry an old one's permissions over.
 */
async function write(accounts: Record<string, Account>): Promise<Result<void>> {
  const target = registryPath();
  const temporary = `${target}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await rm(temporary, { force: true });
    await writeFile(temporary, JSON.stringify({ accounts }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
    return ok(undefined);
  } catch (cause) {
    return err(`could not write ${target}: ${(cause as Error).message}`);
  }
}
