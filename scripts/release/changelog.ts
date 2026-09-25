// `release changelog draft | release | notes`: keeps CHANGELOG.md's Unreleased
// section filled from git history, dates it at `npm version`, and prints one
// version's notes for the GitHub Release.

import { flagBool, NO_POSITIONALS, type Args } from '../../src/ui/args.ts';
import type { Command, CommandGroup } from '../../src/ui/command.ts';
import * as out from '../../src/ui/format.ts';
import { ok, err, type Result } from '../../src/core/result.ts';
import { draft, release, notes, releasable, isVersion } from './changelog-text.ts';
import { projectDir, readPackage, readChangelog, writeChangelog, subjectsSince } from './project.ts';

/** Reports a failed Result under `tag`; true when it failed, so the caller returns 1. */
function failed<T>(tag: string, result: Result<T>): result is Extract<Result<T>, { ok: false }> {
  if (result.ok) return false;
  out.fail(tag, result.error);
  return true;
}

const DRY_RUN = { name: 'dry-run', kind: 'boolean', help: 'print the resulting CHANGELOG.md on stdout instead of writing it' } as const;
const VERSION_ARG = { min: 0, max: 1, label: '<version>' };

/** Writes the file, or with --dry-run prints it; then reports `done` unless it was a dry run. */
function save(args: Args, text: string, done: string): number {
  if (flagBool(args, 'dry-run')) { process.stdout.write(text); return 0; }
  writeChangelog(projectDir(args), text);
  out.pass('changelog', done);
  return 0;
}

interface Target {
  readonly version: string;
  readonly repoUrl: string;
  readonly text: string;
}

/** package.json, CHANGELOG.md and the <version> argument (default: package.json's). Exit code on failure. */
function target(args: Args): Result<Target, number> {
  const dir = projectDir(args);
  const pkg = readPackage(dir);
  if (failed('changelog', pkg)) return err(1);
  const text = readChangelog(dir);
  if (failed('changelog', text)) return err(1);
  const version = args.positional[0] ?? pkg.value.version;
  if (!isVersion(version)) {
    out.fail('changelog', `'${version}' is not a version (x.y.z or x.y.z-pre, no leading v)`);
    return err(2);
  }
  return ok({ version, repoUrl: pkg.value.repoUrl, text: text.value });
}

const draftCommand = {
  summary: 'add commit subjects since the last v* tag to "## [Unreleased]" (edit them afterwards)',
  options: [DRY_RUN],
  positionals: NO_POSITIONALS,
  examples: ['node scripts/release.ts changelog draft --dry-run'],

  async run(args: Args): Promise<number> {
    const dir = projectDir(args);
    const text = readChangelog(dir);
    if (failed('changelog', text)) return 1;
    const subjects = await subjectsSince(dir);
    if (failed('changelog', subjects)) return 1;
    const drafted = draft(text.value, releasable(subjects.value));
    if (failed('changelog', drafted)) return 1;
    const added = drafted.value.added;
    return save(args, drafted.value.text, `${added} new entr${added === 1 ? 'y' : 'ies'} in Unreleased`);
  },
} satisfies Command;

const releaseCommand = {
  summary: 'move Unreleased under "## [<version>] - <today>" (default: package.json version)',
  options: [DRY_RUN],
  positionals: VERSION_ARG,
  examples: ['node scripts/release.ts changelog release 0.2.0 --dry-run'],

  async run(args: Args): Promise<number> {
    const found = target(args);
    if (!found.ok) return found.error;
    const { version, repoUrl, text } = found.value;
    const date = new Date().toISOString().slice(0, 10);
    const released = release(text, { version, date, repoUrl });
    if (failed('changelog', released)) return 1;
    return save(args, released.value, `${version} dated ${date}`);
  },
} satisfies Command;

const notesCommand = {
  summary: 'print one version\'s section on stdout (default: package.json version)',
  positionals: VERSION_ARG,
  examples: ['node scripts/release.ts changelog notes 0.2.0 > notes.md'],

  async run(args: Args): Promise<number> {
    const found = target(args);
    if (!found.ok) return found.error;
    const section = notes(found.value.text, found.value.version);
    if (failed('changelog', section)) return 1;
    process.stdout.write(section.value);
    return 0;
  },
} satisfies Command;

export default {
  summary: 'draft, date and print CHANGELOG.md sections',
  defaultAction: 'notes',
  actions: { draft: draftCommand, release: releaseCommand, notes: notesCommand },
} satisfies CommandGroup;
