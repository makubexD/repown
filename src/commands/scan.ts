// Audit every clone under one or more directories.
//
// The point is to make remediation a decision taken with numbers. A clone that
// inherits the machine identity is not a hypothetical risk: its commits already
// carry whichever address the machine defaults to, and if it has a remote those
// commits are already published.
//
// DOMAINS AND COUNTS BY DEFAULT, never addresses. This output is the kind of
// thing that gets pasted into a chat window or an issue; a domain says
// everything needed to spot the problem and nothing that identifies a person.
// `--emails` opts in for when you need the exact value to fix it.
//
// EVERY identity in the history is listed, including the one the clone would
// inherit. Filtering against the inherited address was the obvious thing to do
// and it was wrong: an unpinned clone's problem IS that its commits carry the
// machine default, so treating that address as the expected one hid precisely
// the repositories worth looking at.

import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { Git } from '../core/git.ts';
import { inspectRepo, type RepoState } from '../core/inspect.ts';
import { ok, err, type Result } from '../core/result.ts';
import { flagBool, flagString, wantsJson, FORMAT_OPTION, type Args } from '../ui/args.ts';
import type { Command } from '../ui/command.ts';
import * as out from '../ui/format.ts';

interface Found {
  readonly root: string;
  readonly path: string;
}

/** What was found, before any formatting: the text table and `--format json` both read this. */
interface Row {
  readonly name: string;
  readonly path: string;
  readonly remote: boolean;
  /** Null with a remote means the owner could not be read from its URL. */
  readonly owner: string | null;
  readonly host: string | null;
  readonly identity: 'pinned' | 'commits-only' | 'inherited';
  readonly guard: string;
  /** Commits per domain (or per address with --emails); null when the history could not be read. */
  readonly history: ReadonlyMap<string, number> | null;
  /** True when a mirror branch was excluded, so the history counts local work only. */
  readonly mirrored: boolean;
}

export default {
  summary: 'audit every clone under a directory',
  positionals: { min: 0, max: Infinity, label: '<dir>' },
  options: [
    { name: 'emails', kind: 'boolean', help: 'show exact addresses instead of domains and counts' },
    { name: 'depth', kind: 'string', default: '3', help: 'how many directories deep to look for a clone' },
    FORMAT_OPTION,
  ],
  examples: ['repown scan', 'repown scan ~/code ~/work --emails', 'repown scan ~/code --format json'],

  async run(args: Args): Promise<number> {
    const target = scanTarget(args);
    if (!target.ok) { out.fail('scan', target.error); return 2; }
    const { roots, depth } = target.value;

    const unreadable: string[] = [];
    const found = (await Promise.all(roots.map((root) => discover({ root, path: root }, depth, unreadable)))).flat();
    for (const path of unreadable) out.warn('scan', 'could not read ' + path + ' -- not scanned');
    if (found.length === 0) {
      out.warn('scan', 'no git repositories found under: ' + roots.join(', '));
      if (wantsJson(args)) out.json([]);
      return 0;
    }

    const showEmails = flagBool(args, 'emails');
    const rows = await mapLimited(found, CONCURRENCY, (entry) => describe(entry, showEmails));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    if (wantsJson(args)) { out.json(rows.map((row) => asJson(row, showEmails))); return 0; }
    render(rows);
    return summarise(rows);
  },
} satisfies Command;

/**
 * Each clone costs about ten git processes. All at once, a folder of a hundred
 * clones launched a thousand; calls then hit exec's timeout, and a killed
 * `git config --get` reads as "not set" -- rows that looked unpinned but weren't.
 */
const CONCURRENCY = 6;

async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function scanTarget(args: Args): Result<{ roots: readonly string[]; depth: number }> {
  const roots = args.positional.length > 0 ? args.positional : [flagString(args, 'cwd') ?? process.cwd()];
  const depth = parseDepth(flagString(args, 'depth')!);
  if (depth === null) return err(`invalid --depth '${flagString(args, 'depth')}': expected a whole number >= 0`);
  const badRoot = roots.map(invalidRoot).find((problem) => problem !== null);
  return badRoot ? err(badRoot) : ok({ roots, depth });
}

function parseDepth(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function invalidRoot(root: string): string | null {
  if (!existsSync(root)) return 'no such directory: ' + root;
  if (!statSync(root).isDirectory()) return 'not a directory: ' + root;
  return null;
}

/** A directory that cannot be listed is reported, never silently left out of the audit. */
async function discover(at: Found, depth: number, unreadable: string[]): Promise<Found[]> {
  if (depth < 0 || !existsSync(at.path)) return [];
  if (existsSync(join(at.path, '.git'))) return [at];

  let entries;
  try { entries = await readdir(at.path, { withFileTypes: true }); }
  catch { unreadable.push(at.path); return []; }
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => join(at.path, entry.name));
  const nested = await Promise.all(directories.map((child) => discover({ root: at.root, path: child }, depth - 1, unreadable)));
  return nested.flat();
}

/**
 * A mirror branch, where configured, is someone else's history passing through
 * this clone. Counting it reports their contributors, not this clone's
 * behaviour, so it is excluded -- when it exists; excluding a ref that is not
 * there made git log fail and the row read as empty history.
 *
 * The name is relative to the scanned root, so two clones of the same project
 * in different folders are told apart instead of printed as one name twice.
 */
async function describe(found: Found, showEmails: boolean): Promise<Row> {
  const git = new Git(found.path);
  const repo = await inspectRepo(git);
  const configured = await git.getConfig('repown.mirrorBranch', 'local');
  const mirror = configured && await git.hasCommit('refs/heads/' + configured) ? configured : null;
  const counts = await git.emailCounts(mirror ? 'refs/heads/' + mirror : undefined);

  return {
    name: relative(found.root, found.path).split(sep).join('/') || found.path,
    path: resolve(found.path),
    remote: repo.originUrl !== null,
    owner: repo.owner,
    host: repo.url ? repo.provider.id : null,
    identity: identityOf(repo),
    guard: repo.guard,
    history: counts.ok ? grouped(counts.value, showEmails) : null,
    mirrored: mirror !== null,
  };
}

function identityOf(repo: RepoState): Row['identity'] {
  if (!repo.identity.name || !repo.identity.email) return 'inherited';
  return repo.identity.account || repo.identity.owner ? 'pinned' : 'commits-only';
}

/** Commits per domain (or address), most first. */
function grouped(counts: ReadonlyMap<string, number>, showEmails: boolean): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const [address, count] of counts) {
    const key = showEmails ? address : domainOf(address);
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  return new Map([...totals.entries()].sort((a, b) => b[1] - a[1]));
}

function historyText(history: Row['history']): string {
  if (history === null) return 'unknown -- history could not be read';
  if (history.size === 0) return '-';
  const ranked = [...history.entries()];
  const shown = ranked.slice(0, 3).map(([key, count]) => key + '=' + count);
  if (ranked.length > shown.length) shown.push('+' + (ranked.length - shown.length) + ' more');
  return shown.join(' ');
}

/** The --format json shape (ADR-014): `history` is null when unread, never an empty guess. */
function asJson(row: Row, showEmails: boolean): Record<string, unknown> {
  const key = showEmails ? 'email' : 'domain';
  return {
    repo: row.name, path: row.path, remote: row.remote, owner: row.owner, host: row.host,
    identity: row.identity, guard: row.guard, mirrorExcluded: row.mirrored,
    history: row.history && [...row.history].map(([value, count]) => ({ [key]: value, count })),
  };
}

/** Malformed addresses do occur in old history; they are reported, not hidden. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return '(no domain)';
  return address.slice(at + 1);
}

function render(rows: readonly Row[]): void {
  const width = Math.max(4, ...rows.map((row) => row.name.length));
  out.line();
  out.line('    ' + header(width));
  out.line('    ' + '-'.repeat(width + 52));
  for (const row of rows) {
    out.line('    ' + [
      row.name.padEnd(width), (row.owner ?? (row.remote ? '?' : 'no remote')).padEnd(14),
      (row.host ?? '-').padEnd(7), IDENTITY_TEXT[row.identity].padEnd(12), row.guard.padEnd(7),
      historyText(row.history) + (row.mirrored ? out.dim('  (excl. mirror)') : ''),
    ].join(' '));
  }
  out.line();
}

const IDENTITY_TEXT: Record<Row['identity'], string> = {
  'pinned': 'pinned', 'commits-only': 'commits only', 'inherited': 'INHERITED',
};

function header(width: number): string {
  return ['repo'.padEnd(width), 'owner'.padEnd(14), 'host'.padEnd(7),
          'identity'.padEnd(12), 'guard'.padEnd(7), 'identities in history'].join(' ');
}

function summarise(rows: readonly Row[]): number {
  const unpinned = rows.filter((row) => row.identity === 'inherited');
  const unguarded = rows.filter((row) => row.guard !== 'on');

  out.field('repositories', String(rows.length), 16);
  out.field('not pinned', String(unpinned.length), 16);
  out.field('not guarded', String(unguarded.length), 16);
  out.line();
  out.line('  The identity column is a FACT, not a verdict: a shared repository');
  out.line('  legitimately carries many addresses. What is worth acting on is a');
  out.line('  repository you own whose history carries an address that is not yours.');
  out.line();
  if (unpinned.length > 0) {
    out.line('  Pin one:  cd <repo> && repown use <account> && repown guard on');
    out.line();
  }
  return 0;
}
