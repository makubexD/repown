// Behaviour `repown setup` must leave exactly as it is. The wizard is added on top
// of the existing commands and runs their own code, so these lock the output it
// reuses or sits next to, and keep its prompt library away from everything else.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../src', import.meta.url));
for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

function repown(args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, input: '', env: process.env, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

const GH_HELPER = '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n' +
                  '[credential "https://gist.github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n';

const RESET = '        = (empty -- resets the helper list, discarding what was configured before)\n';

describe('output the wizard reuses stays byte for byte', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); });
  afterEach(() => box.dispose());

  test('fix --dry-run prints exactly this preview on stdout', () => {
    box.writeGlobalConfig(GH_HELPER);
    const run = repown(['fix', '--dry-run'], box.dir);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, '\n' +
      '  These entries make gh the credential helper, and will be removed:\n\n' +
      '    global:  credential.https://github.com.helper\n' + RESET +
      '        = !gh auth git-credential\n' +
      '    global:  credential.https://gist.github.com.helper\n' + RESET +
      '        = !gh auth git-credential\n\n' +
      '  Nothing else in your config is touched.\n' +
      '  Undo at any time:  gh auth setup-git\n\n' +
      '  (dry run -- nothing was changed)\n\n');
  });

  test('use in an organisation clone prints the documented allowOwner line', () => {
    box.git('remote', 'add', 'origin', 'https://github.com/octo-org/project.git');
    const run = repown(['use', 'octocat', '--name', 'Octo Cat', '--email', 'octocat@example.invalid'], box.dir);
    assert.equal(run.status, 0);
    assert.ok(run.stderr.includes(
      'origin belongs to "octo-org", not "octocat".\n' +
      '       normal for an organisation repository. To stop the guard refusing it:\n' +
      '         git config --local --add repown.allowOwner octo-org\n'), run.stderr);
  });

  test('help lists the same exit codes', () => {
    assert.match(repown(['--help'], box.dir).stdout, /^ {2}Exit codes: 0 success, 1 failure or refusal, 2 usage error\.$/m);
  });
});

/** Every .ts file under src/, as a path relative to src/ with forward slashes. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts')).map((name) => name.replaceAll('\\', '/'));
}

describe('the prompt library stays inside the wizard', () => {
  test('only src/wizard/clack.ts names @clack', () => {
    const naming = sources().filter((file) => readFileSync(join(SRC, file), 'utf8').includes('@clack/'));
    assert.deepEqual(naming.filter((file) => file !== 'wizard/clack.ts'), []);
  });

  // The hook runs the installed CLI (ADR-003): a broken dependency must never be
  // able to stop `guard check`, so nothing may load the adapter at import time.
  test('no file imports the clack adapter statically', () => {
    const importer = /^\s*(?:import|export)\b[^;]*?from\s+'([^']*clack\.ts)'/m;
    assert.ok(importer.test("import { clackPrompter } from './clack.ts';"), 'the pattern must catch a static import');
    assert.ok(!importer.test("const adapter = await import('./clack.ts');"), 'a dynamic import is allowed');
    const found = sources().filter((file) => importer.test(readFileSync(join(SRC, file), 'utf8')));
    assert.deepEqual(found.map((file) => relative('.', file)), []);
  });
});
