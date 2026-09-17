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
import { join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { Git } from '../core/git.ts';
import { inspectRepo, type RepoState } from '../core/inspect.ts';
import { flagBool, flagString, type Args } from '../cli.ts';
import * as out from '../ui/format.ts';

interface Found {
  readonly root: string;
  readonly path: string;
}

interface Row {
  readonly name: string;
  readonly owner: string;
  readonly host: string;
  readonly identity: string;
  readonly guard: string;
  readonly identities: string;
  /** True when a mirror branch was excluded, so the column counts local work only. */
  readonly mirrored: boolean;
}

export default {
  summary: 'audit every clone under a directory',
  usage: 'gid scan <dir>... [--emails] [--depth <n>]',

  async run(args: Args): Promise<number> {
    const roots = args.positional.length > 0 ? args.positional : [process.cwd()];
    const depth = Number(flagString(args, 'depth') ?? '3');
    const showEmails = flagBool(args, 'emails');

    const found = (await Promise.all(roots.map((root) => discover(root, root, depth)))).flat();
    if (found.length === 0) {
      out.warn('scan', 'no git repositories found under: ' + roots.join(', '));
      return 0;
    }

    const rows = await Promise.all(found.map((entry) => describe(entry, showEmails)));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    render(rows);
    return summarise(rows);
  },
};

async function discover(root: string, path: string, depth: number): Promise<Found[]> {
  if (depth < 0 || !existsSync(path)) return [];
  if (existsSync(join(path, '.git'))) return [{ root, path }];

  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => join(path, entry.name));
  const nested = await Promise.all(directories.map((child) => discover(root, child, depth - 1)));
  return nested.flat();
}

async function describe(found: Found, showEmails: boolean): Promise<Row> {
  const git = new Git(found.path);
  const repo = await inspectRepo(git);
  // A mirror branch, where configured, is someone else's history passing
  // through this clone. Counting it reports their contributors, not this
  // clone's behaviour, so it is excluded from the tally.
  const mirror = await git.getConfig('gid.mirrorBranch');
  const counts = await git.emailCounts(mirror ? 'refs/heads/' + mirror : undefined);

  return {
    // Relative to the scanned root, so two clones of the same project in
    // different folders are told apart instead of printed as one name twice.
    name: relative(found.root, found.path).split(sep).join('/') || found.path,
    owner: repo.owner ?? (repo.originUrl ? '?' : 'no remote'),
    host: repo.url ? repo.provider.id : '-',
    identity: identityLabel(repo),
    guard: repo.guard,
    identities: summariseIdentities(counts, showEmails),
    mirrored: mirror !== null,
  };
}

function identityLabel(repo: RepoState): string {
  if (!repo.identity.name || !repo.identity.email) return 'INHERITED';
  return repo.identity.account ? 'pinned' : 'commits only';
}

function summariseIdentities(counts: ReadonlyMap<string, number>, showEmails: boolean): string {
  const grouped = new Map<string, number>();
  for (const [address, count] of counts) {
    const key = showEmails ? address : domainOf(address);
    grouped.set(key, (grouped.get(key) ?? 0) + count);
  }
  if (grouped.size === 0) return '-';

  const ranked = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, 3).map(([key, count]) => key + '=' + count);
  if (ranked.length > shown.length) shown.push('+' + (ranked.length - shown.length) + ' more');
  return shown.join(' ');
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
      row.name.padEnd(width), row.owner.padEnd(14), row.host.padEnd(7),
      row.identity.padEnd(12), row.guard.padEnd(7),
      row.identities + (row.mirrored ? out.dim('  (excl. mirror)') : ''),
    ].join(' '));
  }
  out.line();
}

function header(width: number): string {
  return ['repo'.padEnd(width), 'owner'.padEnd(14), 'host'.padEnd(7),
          'identity'.padEnd(12), 'guard'.padEnd(7), 'identities in history'].join(' ');
}

function summarise(rows: readonly Row[]): number {
  const unpinned = rows.filter((row) => row.identity === 'INHERITED');
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
    out.line('  Pin one:  cd <repo> && gid use <account> && gid guard on');
    out.line();
  }
  return 0;
}
