// `release changelog draft | release | notes`: keeps CHANGELOG.md's Unreleased
// section filled from git history, dates it at `npm version`, and prints one
// version's notes for the GitHub Release.

import { flagBool, NO_POSITIONALS, type Args } from '../../src/ui/args.ts';
import type { Command, CommandGroup } from '../../src/ui/command.ts';
import * as out from '../../src/ui/format.ts';
import type { Result } from '../../src/core/result.ts';
import { draft, release, notes, releasable } from './changelog-text.ts';
import { projectDir, readPackage, readChangelog, writeChangelog, subjectsSince } from './project.ts';

/** Reports a failed Result under `tag`; true when it failed, so the caller returns 1. */
function failed<T>(tag: string, result: Result<T>): result is Extract<Result<T>, { ok: false }> {
  if (result.ok) return false;
  out.fail(tag, result.error);
  return true;
}

const draftCommand = {
  summary: 'add commit subjects since the last v* tag to "## [Unreleased]" (edit them afterwards)',
  options: [{ name: 'dry-run', kind: 'boolean', help: 'print the drafted CHANGELOG.md on stdout instead of writing it' }],
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
    if (flagBool(args, 'dry-run')) { process.stdout.write(drafted.value.text); return 0; }
    writeChangelog(dir, drafted.value.text);
    out.pass('changelog', `${drafted.value.added} new entr${drafted.value.added === 1 ? 'y' : 'ies'} in Unreleased`);
    return 0;
  },
} satisfies Command;

const VERSION_ARG = { min: 0, max: 1, label: '<version>' };

const releaseCommand = {
  summary: 'move Unreleased under "## [<version>] - <today>" (default: package.json version)',
  positionals: VERSION_ARG,
  examples: ['node scripts/release.ts changelog release 0.2.0'],

  async run(args: Args): Promise<number> {
    const dir = projectDir(args);
    const pkg = readPackage(dir);
    if (failed('changelog', pkg)) return 1;
    const text = readChangelog(dir);
    if (failed('changelog', text)) return 1;
    const version = args.positional[0] ?? pkg.value.version;
    const date = new Date().toISOString().slice(0, 10);
    const released = release(text.value, { version, date, repoUrl: pkg.value.repoUrl });
    if (failed('changelog', released)) return 1;
    writeChangelog(dir, released.value);
    out.pass('changelog', `${version} dated ${date}`);
    return 0;
  },
} satisfies Command;

const notesCommand = {
  summary: 'print one version\'s section on stdout (default: package.json version)',
  positionals: VERSION_ARG,
  examples: ['node scripts/release.ts changelog notes 0.2.0 | gh release create v0.2.0 --notes-file -'],

  async run(args: Args): Promise<number> {
    const dir = projectDir(args);
    const pkg = readPackage(dir);
    if (failed('changelog', pkg)) return 1;
    const text = readChangelog(dir);
    if (failed('changelog', text)) return 1;
    const section = notes(text.value, args.positional[0] ?? pkg.value.version);
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
