// CHANGELOG.md as text, in the Keep a Changelog layout: pure transforms with no
// file or git access, so every rule here is tested without a repository.
//
//   ## [Unreleased]          <- `draft` appends here; `release` empties it
//   ## [0.2.0] - 2026-10-01  <- `release` writes this heading; `notes` reads its body
//   [Unreleased]: <repo>/compare/v0.2.0...HEAD
//   [0.2.0]: <repo>/compare/v0.1.0...v0.2.0

import { ok, err, type Result } from '../../src/core/result.ts';

export interface Release {
  readonly version: string;
  readonly date: string;
  readonly repoUrl: string;
}

export interface Drafted {
  readonly text: string;
  readonly added: number;
}

const UNRELEASED = 'Unreleased';
const LINK_REF = /^\[[^\]]+\]: /m;
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m;
const VERSION_SUBJECT = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Where one `## [name]` section's body starts and ends (the next heading or the link references). */
interface Section {
  readonly bodyStart: number;
  readonly end: number;
}

function findSection(text: string, name: string): Section | null {
  const heading = new RegExp('^## \\[' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\].*$', 'm').exec(text);
  if (!heading) return null;
  const bodyStart = heading.index + heading[0].length + 1;
  const after = text.slice(bodyStart);
  const ends = [/^## /m.exec(after)?.index, LINK_REF.exec(after)?.index].filter((at) => at !== undefined);
  return { bodyStart, end: bodyStart + (ends.length > 0 ? Math.min(...ends) : after.length) };
}

/** A section body's lines, trimmed at both ends but with its inner blank lines (between `###` groups) kept. */
function entriesOf(body: string): string[] {
  const trimmed = body.replace(/\r\n/g, '\n').trim();
  return trimmed.length > 0 ? trimmed.split('\n') : [];
}

/** Replaces a section's body with `lines`, keeping one blank line on each side. */
function withBody(text: string, section: Section, lines: readonly string[]): string {
  const rest = text.slice(section.end);
  const body = lines.length > 0 ? '\n' + lines.join('\n') + '\n' : '';
  return text.slice(0, section.bodyStart) + body + (rest.length > 0 ? '\n' + rest : '');
}

/** Commit subjects worth a changelog line: not planning commits, not `npm version` commits. */
export function releasable(subjects: readonly string[]): string[] {
  return subjects.filter((subject) => !subject.startsWith('Plan: ') && !VERSION_SUBJECT.test(subject));
}

export function draft(text: string, subjects: readonly string[]): Result<Drafted> {
  const section = findSection(text, UNRELEASED);
  if (!section) return err('CHANGELOG.md has no "## [Unreleased]" heading');
  const existing = entriesOf(text.slice(section.bodyStart, section.end));
  const fresh = [...new Set(subjects)].filter((subject) => !existing.some((line) => line.includes(subject)));
  if (fresh.length === 0) return ok({ text, added: 0 });
  return ok({ text: withBody(text, section, [...existing, ...fresh.map((subject) => '- ' + subject)]), added: fresh.length });
}

export function release(text: string, target: Release): Result<string> {
  const section = findSection(text, UNRELEASED);
  if (!section) return err('CHANGELOG.md has no "## [Unreleased]" heading');
  if (findSection(text, target.version)) return err(`CHANGELOG.md already has a section for ${target.version}`);
  const entries = entriesOf(text.slice(section.bodyStart, section.end));
  if (entries.length === 0) return err('the Unreleased section is empty: say what changed (npm run changelog drafts it)');
  const previous = VERSION_HEADING.exec(text)?.[1];
  const moved = withBody(text, section, ['## [' + target.version + '] - ' + target.date, '', ...entries]);
  return ok(withLinks(moved, target, previous));
}

function withLinks(text: string, target: Release, previous: string | undefined): string {
  const v = 'v' + target.version;
  const own = previous ? `${target.repoUrl}/compare/v${previous}...${v}` : `${target.repoUrl}/releases/tag/${v}`;
  const refs = `[Unreleased]: ${target.repoUrl}/compare/${v}...HEAD\n[${target.version}]: ${own}\n`;
  const cleaned = text.replace(/^\[Unreleased\]: .*(\r?\n|$)/m, '');
  const at = LINK_REF.exec(cleaned)?.index;
  if (at === undefined) return cleaned.trimEnd() + '\n\n' + refs;
  return cleaned.slice(0, at) + refs + cleaned.slice(at);
}

export function notes(text: string, version: string): Result<string> {
  const section = findSection(text, version);
  if (!section) return err(`CHANGELOG.md has no section for ${version}`);
  const entries = entriesOf(text.slice(section.bodyStart, section.end));
  return ok(entries.length > 0 ? entries.join('\n') + '\n' : '');
}

/** `git+https://github.com/o/r.git` (or `{ url }`) -> `https://github.com/o/r`. */
export function repoWebUrl(repository: unknown): string | null {
  const url = typeof repository === 'string' ? repository : (repository as { url?: unknown } | null)?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}
