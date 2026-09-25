// The release tool in scripts/: its pure CHANGELOG transforms, and its command
// surface (help, exit codes, the stdout/stderr split) driven through the real
// entry point against sandbox repositories.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';
import { draft, release, notes, releasable, repoWebUrl } from '../scripts/release/changelog-text.ts';
import { inspectPack } from '../scripts/release/pack.ts';

const TOOL = fileURLToPath(new URL('../scripts/release.ts', import.meta.url));
for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

const REPO = 'https://github.com/octocat/hello-world';
const HEADER = '# Changelog\n\nNotes.\n\n';

function changelog(unreleased: string, rest = ''): string {
  return HEADER + '## [Unreleased]\n' + unreleased + rest;
}

describe('changelog text: release', () => {
  test('moves Unreleased under a dated version heading and adds its compare links', () => {
    const text = changelog('\n- Added a thing\n', `\n[Unreleased]: ${REPO}/compare/HEAD\n`);
    const result = release(text, { version: '0.1.0', date: '2026-09-24', repoUrl: REPO });
    assert.ok(result.ok);
    assert.match(result.value, /## \[Unreleased\]\n\n## \[0\.1\.0\] - 2026-09-24\n\n- Added a thing\n/);
    assert.match(result.value, new RegExp(`\\[Unreleased\\]: ${REPO}/compare/v0\\.1\\.0\\.\\.\\.HEAD`));
    assert.match(result.value, new RegExp(`\\[0\\.1\\.0\\]: ${REPO}/releases/tag/v0\\.1\\.0`));
  });

  test('links a later version to a compare against the previous one', () => {
    const first = release(changelog('\n- one\n'), { version: '0.1.0', date: '2026-09-24', repoUrl: REPO });
    assert.ok(first.ok);
    const withMore = first.value.replace('## [Unreleased]\n', '## [Unreleased]\n\n- two\n');
    const second = release(withMore, { version: '0.2.0', date: '2026-10-01', repoUrl: REPO });
    assert.ok(second.ok);
    assert.match(second.value, new RegExp(`\\[0\\.2\\.0\\]: ${REPO}/compare/v0\\.1\\.0\\.\\.\\.v0\\.2\\.0`));
    assert.match(second.value, new RegExp(`\\[Unreleased\\]: ${REPO}/compare/v0\\.2\\.0\\.\\.\\.HEAD`));
  });

  test('refuses an empty Unreleased section, so a release always says what changed', () => {
    const result = release(changelog('\n\n'), { version: '0.1.0', date: '2026-09-24', repoUrl: REPO });
    assert.equal(result.ok, false);
  });

  test('refuses a version that is already in the changelog', () => {
    const text = changelog('\n- again\n', '\n## [0.1.0] - 2026-09-24\n\n- once\n');
    assert.equal(release(text, { version: '0.1.0', date: '2026-09-25', repoUrl: REPO }).ok, false);
  });

  test('refuses a file with no Unreleased heading', () => {
    assert.equal(release(HEADER, { version: '0.1.0', date: '2026-09-24', repoUrl: REPO }).ok, false);
  });
});

describe('changelog text: notes and draft', () => {
  test('notes returns one version\'s section body, without its heading or the next section', () => {
    const text = changelog('\n', '\n## [0.2.0] - 2026-10-01\n\n- two\n\n## [0.1.0] - 2026-09-24\n\n- one\n');
    assert.deepEqual(notes(text, '0.2.0'), { ok: true, value: '- two\n' });
    assert.equal(notes(text, '9.9.9').ok, false);
  });

  test('draft appends new subjects to Unreleased and skips the ones already there', () => {
    const result = draft(changelog('\n- Old entry\n', '\n## [0.1.0] - 2026-09-24\n'), ['New entry', 'Old entry']);
    assert.ok(result.ok);
    assert.match(result.value.text, /## \[Unreleased\]\n\n- Old entry\n- New entry\n\n## \[0\.1\.0\]/);
    assert.equal(result.value.added, 1);
  });

  test('releasable drops plan commits and version-bump commits', () => {
    assert.deepEqual(releasable(['Plan: npm publishing', '0.2.0', '1.0.0-beta.1', 'Fix a thing']), ['Fix a thing']);
  });

  test('repoWebUrl turns package.json repository forms into a browsable URL', () => {
    assert.equal(repoWebUrl('git+https://github.com/octocat/hello-world.git'), REPO);
    assert.equal(repoWebUrl({ url: 'git+https://github.com/octocat/hello-world.git' }), REPO);
  });
});

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }

function tool(args: readonly string[], cwd?: string, input = ''): Run {
  const result = spawnSync(process.execPath, [TOOL, ...args], { cwd, input, env: process.env, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('release tool: command surface', () => {
  test('no arguments and --help print the same top help on stdout and exit 0', () => {
    const bare = tool([]);
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, /changelog/);
    assert.equal(tool(['--help']).stdout, bare.stdout);
  });

  test('group and action help name the tool, not repown', () => {
    const run = tool(['changelog', 'draft', '--help']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /node scripts\/release\.ts changelog draft/);
    assert.doesNotMatch(run.stdout, /repown changelog/);
    assert.equal(tool(['help', 'changelog', 'draft']).stdout, run.stdout);
  });

  test('an unknown command or option is a usage error: exit 2, stderr only', () => {
    const run = tool(['changelg']);
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /did you mean 'changelog'/);
    assert.equal(tool(['changelog', 'draft', '--nope']).status, 2);
  });
});

describe('release tool: changelog against a repository', () => {
  let box: Sandbox;
  const file = (): string => join(box.dir, 'CHANGELOG.md');

  beforeEach(() => {
    box = sandbox();
    writeFileSync(join(box.dir, 'package.json'), JSON.stringify({ version: '0.2.0', repository: { url: `git+${REPO}.git` } }));
    writeFileSync(file(), changelog('\n', `\n## [0.1.0] - 2026-09-24\n\n- one\n\n[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`));
    box.git('commit', '-q', '--allow-empty', '-m', 'Before the tag');
    box.git('tag', '-a', 'v0.1.0', '-m', '0.1.0');
    for (const subject of ['Plan: something', 'Add a feature', 'Fix a bug']) box.git('commit', '-q', '--allow-empty', '-m', subject);
  });
  afterEach(() => box.dispose());

  test('draft --dry-run prints the drafted file on stdout and leaves it unchanged', () => {
    const before = readFileSync(file(), 'utf8');
    const run = tool(['changelog', 'draft', '--dry-run', '--cwd', box.dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /## \[Unreleased\]\n\n- Fix a bug\n- Add a feature\n/);
    assert.doesNotMatch(run.stdout, /Plan: something|Before the tag/);
    assert.equal(readFileSync(file(), 'utf8'), before);
  });

  test('draft writes the file; release then dates it from package.json; notes prints it', () => {
    assert.equal(tool(['changelog', 'draft', '--cwd', box.dir]).status, 0);
    const released = tool(['changelog', 'release', '--cwd', box.dir]);
    assert.equal(released.status, 0, released.stderr);
    assert.match(readFileSync(file(), 'utf8'), /## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n- Fix a bug\n- Add a feature\n/);
    const run = tool(['changelog', 'notes', '0.2.0', '--cwd', box.dir]);
    assert.equal(run.stdout, '- Fix a bug\n- Add a feature\n');
  });

  test('release with an empty Unreleased fails with exit 1 and changes nothing', () => {
    const before = readFileSync(file(), 'utf8');
    const run = tool(['changelog', 'release', '--cwd', box.dir]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Unreleased/);
    assert.equal(readFileSync(file(), 'utf8'), before);
  });

  test('notes for a version that is not there fails with exit 1', () => {
    assert.equal(tool(['changelog', 'notes', '9.9.9', '--cwd', box.dir]).status, 1);
  });
});

describe('pack contents', () => {
  const files = (...paths: string[]): string => JSON.stringify([{ name: 'repown', version: '0.1.0', size: 2048, files: paths.map((path) => ({ path, size: 1 })) }]);
  const good = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'dist/cli.js', 'dist/ui/help.js'];

  test('a tarball with the entry point, readme, licence and changelog, and nothing else, passes', () => {
    const result = inspectPack(files(...good));
    assert.ok(result.ok);
    assert.equal(result.value.files, good.length);
  });

  test('lists every missing required file and every file that must not ship', () => {
    const result = inspectPack(files('package.json', 'README.md', 'dist/cli.js.map', 'src/cli.ts', 'scripts/release.ts', 'test/a.test.ts'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    for (const expected of ['LICENSE', 'CHANGELOG.md', 'dist/cli.js', 'dist/cli.js.map', 'src/cli.ts', 'scripts/release.ts', 'test/a.test.ts']) {
      assert.ok(result.error.some((problem) => problem.includes(expected)), expected + ' not reported');
    }
  });

  test('input that is not npm pack --json output is refused, not passed', () => {
    assert.equal(inspectPack('> repown@0.1.0 build').ok, false);
    assert.equal(inspectPack('[]').ok, false);
  });

  test('check package reads a file or - (stdin), exit 0 on a good list and 1 on a bad one', () => {
    assert.equal(tool(['check', 'package', '-'], undefined, files(...good)).status, 0);
    const bad = tool(['check', 'package', '-'], undefined, files('package.json'));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /dist\/cli\.js/);
  });
});

describe('release tool: check repo', () => {
  let box: Sandbox;
  let remote: Sandbox;

  beforeEach(() => {
    remote = sandbox();
    box = sandbox();
    writeFileSync(join(box.dir, 'CHANGELOG.md'), changelog('\n- Something changed\n'));
    box.git('add', 'CHANGELOG.md');
    box.git('commit', '-q', '-m', 'Start');
    box.git('init', '-q', '--bare', join(remote.dir, 'origin.git'));
    box.git('remote', 'add', 'origin', join(remote.dir, 'origin.git'));
    box.git('push', '-q', '-u', 'origin', 'main');
  });
  afterEach(() => { box.dispose(); remote.dispose(); });

  const check = (): Run => tool(['check', 'repo', '--cwd', box.dir]);

  test('a clean main, level with origin, with Unreleased entries passes every check', () => {
    const run = check();
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, /FAIL|skipped/);
    assert.equal(tool(['check', '--cwd', box.dir]).status, 0);
  });

  test('a dirty tree fails', () => {
    writeFileSync(join(box.dir, 'stray.txt'), 'x');
    const run = check();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /FAIL .*uncommitted/);
  });

  test('another branch fails', () => {
    box.git('switch', '-q', '-c', 'topic');
    assert.match(check().stderr, /FAIL .*topic/);
  });

  test('being behind the upstream fails', () => {
    box.git('commit', '-q', '--allow-empty', '-m', 'ahead');
    box.git('push', '-q', 'origin', 'main');
    box.git('reset', '-q', '--hard', 'HEAD~1');
    const run = check();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /FAIL .*behind/);
  });

  test('no upstream is reported as skipped, never as passed', () => {
    box.git('branch', '--unset-upstream');
    const run = check();
    assert.match(run.stderr, /skipped/);
    assert.doesNotMatch(run.stdout, /upstream/);
  });

  test('an empty Unreleased section fails', () => {
    writeFileSync(join(box.dir, 'CHANGELOG.md'), changelog('\n'));
    box.git('commit', '-q', '-am', 'Empty it');
    box.git('push', '-q');
    assert.match(check().stderr, /FAIL .*Unreleased/);
  });
});

describe('package.json is publishable', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    private?: boolean; publishConfig?: { access?: string }; scripts: Record<string, string>;
  };

  test('it is not marked private, and publishes publicly', () => {
    assert.notEqual(pkg.private, true);
    assert.equal(pkg.publishConfig?.access, 'public');
  });

  test('npm version runs the checks first and dates the changelog', () => {
    assert.match(pkg.scripts['preversion'] ?? '', /release:check/);
    assert.match(pkg.scripts['version'] ?? '', /changelog release/);
    assert.match(pkg.scripts['version'] ?? '', /git add CHANGELOG\.md/);
  });

  test('the real tarball passes check package', () => {
    const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', shell: process.platform === 'win32',
    });
    assert.equal(pack.status, 0, pack.stderr);
    const run = tool(['check', 'package', '-'], undefined, pack.stdout);
    assert.equal(run.status, 0, run.stderr);
  });
});
