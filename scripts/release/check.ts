// `release check repo | tag | package`: what must be true before a version is
// cut (np's pre-publish checklist, minus what npm scripts already run: tests and
// build), and before it is published. A check that could not run is reported as
// skipped, never as passed.

import { run, output, succeeded, lines } from '../../src/core/exec.ts';
import { ok, type Result } from '../../src/core/result.ts';
import { flagString, type Args } from '../../src/ui/args.ts';
import type { Command, CommandGroup } from '../../src/ui/command.ts';
import * as out from '../../src/ui/format.ts';
import { unreleased } from './changelog-text.ts';
import { inspectPack } from './pack.ts';
import { projectDir, projectFile, readChangelog, readPackage, readText } from './project.ts';

interface Outcome {
  readonly tag: string;
  readonly state: 'pass' | 'fail' | 'skip';
  readonly message: string;
}

const outcome = (tag: string, state: Outcome['state'], message: string): Outcome => ({ tag, state, message });
const git = (dir: string, args: readonly string[]) => run('git', args, { cwd: dir });

async function onBranch(dir: string, branch: string): Promise<Outcome> {
  const current = output(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']));
  if (current === branch) return outcome('branch', 'pass', 'on ' + branch);
  return outcome('branch', 'fail', `on ${current ?? 'no branch'}, not ${branch}: releases are cut from ${branch}`);
}

async function cleanTree(dir: string): Promise<Outcome> {
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=no']);
  if (!succeeded(status)) return outcome('tree', 'fail', 'git status failed: ' + status.stderr.trim());
  if (status.stdout.trim() === '') return outcome('tree', 'pass', 'no uncommitted changes');
  return outcome('tree', 'fail', 'uncommitted changes: commit or stash them first');
}

async function levelWithUpstream(dir: string): Promise<Outcome> {
  const upstream = output(await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
  if (!upstream) return outcome('upstream', 'skip', 'skipped: this branch has no upstream to compare against');
  const fetched = await git(dir, ['fetch', '--quiet']);
  if (!succeeded(fetched)) return outcome('upstream', 'fail', 'could not fetch: ' + fetched.stderr.trim());
  const behind = output(await git(dir, ['rev-list', '--count', 'HEAD..@{u}']));
  if (behind === '0') return outcome('upstream', 'pass', 'level with ' + upstream);
  return outcome('upstream', 'fail', `behind ${upstream} by ${behind ?? '?'} commit(s): pull first`);
}

/**
 * `npm version` only tags a commit after its preversion hook passed the checks,
 * the tests and the build, so the tag is the proof a publish needs.
 */
async function taggedVersion(dir: string): Promise<Outcome> {
  const pkg = readPackage(dir);
  if (!pkg.ok) return outcome('tag', 'fail', pkg.error);
  const tag = 'v' + pkg.value.version;
  const tags = await git(dir, ['tag', '--points-at', 'HEAD']);
  if (!succeeded(tags)) return outcome('tag', 'fail', 'git tag failed: ' + tags.stderr.trim());
  if (lines(tags).includes(tag)) return outcome('tag', 'pass', 'HEAD is ' + tag);
  return outcome('tag', 'fail', `HEAD is not tagged ${tag}: cut the version with npm run release:*, then publish`);
}

function changelogFilled(dir: string): Outcome {
  const text = readChangelog(dir);
  const entries = text.ok ? unreleased(text.value) : text;
  if (!entries.ok) return outcome('changelog', 'fail', entries.error);
  if (entries.value.length === 0) return outcome('changelog', 'fail', 'the Unreleased section is empty: run npm run changelog');
  return outcome('changelog', 'pass', `${entries.value.length} line(s) under Unreleased`);
}

function report(outcomes: readonly Outcome[]): number {
  for (const { tag, state, message } of outcomes) {
    if (state === 'pass') out.pass(tag, message);
    else if (state === 'skip') out.warn(tag, message);
    else out.fail(tag, message);
  }
  return outcomes.some((entry) => entry.state === 'fail') ? 1 : 0;
}

const repoCommand = {
  summary: 'the repository is ready to cut a version: branch, clean tree, level with upstream (runs git fetch), Unreleased entries',
  options: [{ name: 'branch', kind: 'string', default: 'main', help: 'the branch releases are cut from' }],
  examples: ['node scripts/release.ts check repo'],

  async run(args: Args): Promise<number> {
    const dir = projectDir(args);
    const branch = flagString(args, 'branch') ?? 'main';
    return report([await onBranch(dir, branch), await cleanTree(dir), await levelWithUpstream(dir), changelogFilled(dir)]);
  },
} satisfies Command;

const tagCommand = {
  summary: 'HEAD is the v<version> tag npm version made, with no uncommitted changes (run before publishing)',
  examples: ['node scripts/release.ts check tag'],

  async run(args: Args): Promise<number> {
    const dir = projectDir(args);
    return report([await taggedVersion(dir), await cleanTree(dir)]);
  },
} satisfies Command;

/** `-` is stdin; anything else is a file, relative to --cwd. */
async function readInput(args: Args, source: string): Promise<Result<string>> {
  if (source !== '-') return readText(projectFile(args, source));
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk as string;
  return ok(text);
}

const packageCommand = {
  summary: 'a tarball list (npm pack --dry-run --json) holds package.json, dist/cli.js, README, LICENSE and CHANGELOG, and no source maps, sources, tests, docs or secrets',
  positionals: { min: 1, max: 1, label: '<file|->', stdin: true },
  examples: ['npm pack --dry-run --json | node scripts/release.ts check package -'],

  async run(args: Args): Promise<number> {
    const input = await readInput(args, args.positional[0]!);
    if (!input.ok) return report([outcome('package', 'fail', input.error)]);
    const result = inspectPack(input.value);
    if (!result.ok) return report(result.error.map((problem) => outcome('package', 'fail', problem)));
    const kilobytes = (result.value.size / 1024).toFixed(1);
    return report([outcome('package', 'pass', `${result.value.files} files, ${kilobytes} kB packed`)]);
  },
} satisfies Command;

export default {
  summary: 'preflight checks before a version is cut',
  defaultAction: 'repo',
  actions: { repo: repoCommand, tag: tagCommand, package: packageCommand },
} satisfies CommandGroup;
