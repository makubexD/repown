// The per-machine account registry: name and email per account, recorded once.
//
// THIS IS WHAT MAKES `gid use <account>` A ONE-WORD COMMAND. Without it, pinning
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

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
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
}

const EMPTY: Registry = { accounts: {} };

export function configDirectory(): string {
  const explicit = process.env['GID_CONFIG_DIR'];
  if (explicit) return explicit;

  if (process.platform === 'win32' && process.env['APPDATA']) {
    return join(process.env['APPDATA'], 'gid');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg ? join(xdg, 'gid') : join(homedir(), '.config', 'gid');
}

export function registryPath(): string {
  return join(configDirectory(), 'accounts.json');
}

/** An absent or unreadable registry is an EMPTY one, never a crash. */
export async function loadRegistry(): Promise<Registry> {
  try {
    const raw = await readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(raw) as { accounts?: Record<string, Account> };
    return { accounts: parsed.accounts ?? {} };
  } catch {
    return EMPTY;
  }
}

export async function lookupAccount(account: string): Promise<Account | null> {
  const registry = await loadRegistry();
  return registry.accounts[account] ?? null;
}

export async function saveAccount(account: string, entry: Account): Promise<Result<void>> {
  const registry = await loadRegistry();
  return write({ accounts: { ...registry.accounts, [account]: entry } });
}

export async function removeAccount(account: string): Promise<Result<boolean>> {
  const registry = await loadRegistry();
  if (!(account in registry.accounts)) return ok(false);

  const accounts = { ...registry.accounts };
  delete accounts[account];
  const written = await write({ accounts });
  return written.ok ? ok(true) : err(written.error);
}

/** Written via a temporary file and renamed, so an interrupted write cannot truncate it. */
async function write(registry: Registry): Promise<Result<void>> {
  const target = registryPath();
  const temporary = `${target}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    await rename(temporary, target);
    return ok(undefined);
  } catch (cause) {
    return err(`could not write ${target}: ${(cause as Error).message}`);
  }
}
