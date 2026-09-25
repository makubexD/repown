// What a published tarball must and must not hold, read from
// `npm pack --dry-run --json`. The release tool never runs npm itself: npm is
// `npm.cmd` on Windows, which cannot be spawned with shell: false.

import { ok, err, type Result } from '../../src/core/result.ts';

export interface PackSummary {
  readonly files: number;
  readonly size: number;
}

const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/cli.js'];
const FORBIDDEN: readonly RegExp[] = [
  /\.map$/, /\.tgz$/, /(^|\/)\.env/, /(^|\/)\.npmrc$/,
  /^(src|test|scripts|docs|demo|tasks|_Others|\.github|\.claude)\//,
];

interface PackEntry {
  readonly size?: number;
  readonly files?: readonly { readonly path?: unknown }[];
}

function parse(json: string): Result<PackEntry> {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return err('not JSON: pipe `npm pack --dry-run --json` into this'); }
  const entry = Array.isArray(parsed) ? (parsed[0] as PackEntry | undefined) : undefined;
  if (!entry || !Array.isArray(entry.files)) return err('no file list: expected the output of `npm pack --dry-run --json`');
  return ok(entry);
}

function problems(paths: readonly string[]): string[] {
  const missing = REQUIRED.filter((path) => !paths.includes(path)).map((path) => 'missing ' + path);
  const unwanted = paths.filter((path) => FORBIDDEN.some((rule) => rule.test(path))).map((path) => 'must not ship ' + path);
  return [...missing, ...unwanted];
}

export function inspectPack(json: string): Result<PackSummary, string[]> {
  const entry = parse(json);
  if (!entry.ok) return err([entry.error]);
  const paths = (entry.value.files ?? []).map((file) => String(file.path));
  const found = problems(paths);
  if (found.length > 0) return err(found);
  return ok({ files: paths.length, size: entry.value.size ?? 0 });
}
