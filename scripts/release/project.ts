// What the release tool reads from the project it runs in: package.json,
// CHANGELOG.md and git history. Every git call goes through src/core/exec.ts
// (shell: false), and every `git log` passes --no-show-signature. Nothing here
// throws for bad input: an unreadable file or invalid JSON is a Result.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run, lines, output } from '../../src/core/exec.ts';
import { ok, err, type Result } from '../../src/core/result.ts';
import { flagString, type Args } from '../../src/ui/args.ts';
import { repoWebUrl } from './changelog-text.ts';

export interface Package {
  readonly version: string;
  readonly repoUrl: string;
}

/** The project directory: `--cwd`, else where the tool was started. */
export function projectDir(args: Args): string {
  return flagString(args, 'cwd') ?? process.cwd();
}

/** A file named on the command line, resolved against the project directory. */
export function projectFile(args: Args, name: string): string {
  return resolve(projectDir(args), name);
}

export function readText(path: string): Result<string> {
  try {
    return ok(readFileSync(path, 'utf8'));
  } catch (error) {
    return err(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

function parseJson(text: string, name: string): Result<unknown> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (error) {
    return err(`${name} is not valid JSON: ${(error as Error).message}`);
  }
}

export function readPackage(dir: string): Result<Package> {
  const text = readText(join(dir, 'package.json'));
  if (!text.ok) return text;
  const parsed = parseJson(text.value, 'package.json');
  if (!parsed.ok) return parsed;
  const pkg = (parsed.value ?? {}) as { version?: unknown; repository?: unknown };
  const repoUrl = repoWebUrl(pkg.repository);
  if (typeof pkg.version !== 'string') return err('package.json has no version');
  if (!repoUrl) return err('package.json has no repository url');
  return ok({ version: pkg.version, repoUrl });
}

export function changelogPath(dir: string): string {
  return join(dir, 'CHANGELOG.md');
}

/** CHANGELOG.md with LF line endings, whatever a Windows checkout (autocrlf) gave it. */
export function readChangelog(dir: string): Result<string> {
  const text = readText(changelogPath(dir));
  return text.ok ? ok(text.value.replace(/\r\n/g, '\n')) : text;
}

export function writeChangelog(dir: string, text: string): void {
  writeFileSync(changelogPath(dir), text);
}

/** The newest `v*` tag reachable from HEAD, or null when there is none yet. */
export async function lastTag(dir: string): Promise<string | null> {
  return output(await run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: dir }));
}

/** Commit subjects since the last `v*` tag (all of history before the first), newest first. */
export async function subjectsSince(dir: string): Promise<Result<string[]>> {
  const tag = await lastTag(dir);
  const range = tag ? [tag + '..HEAD'] : ['HEAD'];
  const result = await run('git', ['log', '--no-show-signature', '--no-merges', '--format=%s', ...range], { cwd: dir });
  if (result.code !== 0) return err('git log failed in ' + dir + ': ' + result.stderr.trim());
  return ok(lines(result));
}
