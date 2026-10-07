// Behaviour `repown setup` must leave exactly as it is. The wizard is added on top
// of the existing commands and runs their own code, so these lock the output it
// reuses or sits next to, and keep its prompt library away from everything else.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { plainTerminal, sandbox, type Sandbox } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../src', import.meta.url));
plainTerminal();

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

  test('help lists the same exit codes, and 130 for a cancelled setup or start screen', () => {
    assert.match(repown(['--help'], box.dir).stdout, /^ {2}Exit codes: 0 success, 1 failure or refusal, 2 usage error,$/m);
    assert.match(repown(['--help'], box.dir).stdout, /^ {2}130 cancelled \(setup, the start screen\)\.$/m);
  });

  test('help names every accounts action, and that add looks the login up on GitHub', () => {
    const top = repown(['--help'], box.dir).stdout;
    assert.match(top, /^ {2}accounts {2}list, record or forget the accounts this machine knows$/m);
    const add = repown(['help', 'accounts', 'add'], box.dir).stdout;
    assert.match(add.replace(/\s+/g, ' '), /asks for its name and email once; on GitHub, suggested from its profile through gh/);
  });
});

/** Every .ts file under src/, as a path relative to src/ with forward slashes. */
function sources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts')).map((name) => name.replaceAll('\\', '/'));
}

/** An import of a package under @clack/, in any form: static, side effect, re-export or dynamic. */
const CLACK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)['"`]@clack\//m;

// A clone with nothing in the way of its next push: what setup and status say stays as it is
// while they learn to name what DOES get in the way (push blockers). Local-path remote, so no
// host's credential store is read.
describe('a clean clone keeps its setup and status output', () => {
  let box: Sandbox;
  beforeEach(() => { box = sandbox(); cleanClone(box); });
  afterEach(() => box.dispose());

  const setupArgs = ['setup', 'octocat', '--name=Octo Cat', '--email=octocat@example.invalid', '--guard', '--auto-upstream', '--no-input'];

  test('a first setup lists its steps, says done, and what changed', () => {
    const run = repown(setupArgs, box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr,
      '       step 1 of 4: Record the account octocat on this machine: octocat@example.invalid\n' +
      '       $ repown accounts add octocat --name "Octo Cat" --email octocat@example.invalid\n\n' +
      '       step 2 of 4: Pin this clone to octocat: its commit name and email\n' +
      '       $ repown use octocat\n\n' +
      '       step 3 of 4: Turn on the push guard: each push is checked first\n' +
      '       $ repown guard on\n\n' +
      '       step 4 of 4: Push branches without -u: the first push sets the upstream (this clone only)\n' +
      '       $ git config --local push.autoSetupRemote true\n\n' +
      '       done: this clone is set up for octocat\n' +
      '       changed in this clone:\n' +
      '         user.name: Sandbox -> Octo Cat\n' +
      '         user.email: sandbox@example.invalid -> octocat@example.invalid\n' +
      '         user.useConfigOnly: (added) true\n' +
      '         repown.account: (added) octocat\n' +
      '         push.autoSetupRemote: (added) true\n' +
      '         push guard: off -> on\n' +
      '       changed on this machine:\n' +
      "         this machine's account registry: added octocat\n" +
      '       check it any time: repown status (this clone), repown doctor (this machine)\n');
  });

  test('setup again, with no input, changes nothing and says done', () => {
    repown(setupArgs, box.dir);
    const run = repown(['setup', 'octocat', '--no-input'], box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, '\n       done: this clone is set up for octocat\n       nothing changed in this clone\n' +
      '       check it any time: repown status (this clone), repown doctor (this machine)\n');
  });

  test('status shows the clone block and says ready', () => {
    repown(setupArgs, box.dir);
    const run = repown(['status'], box.dir);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('This clone\n' +
      '  commits as     Octo Cat <octocat@example.invalid>\n' +
      '  pushes as      not pinned by repown on this host\n' +
      '  account        octocat  (recorded)\n' +
      '  origin         unknown  (this host)\n' +
      '  upstream       origin/main\n' +
      '  push guard     on\n'), run.stdout);
    assert.equal(run.stderr, '\nready: commits use octocat; pushes use this host\'s own sign-in\n');
  });
});

/** One commit by the account, pushed with -u to a bare origin by path: nothing left to push. */
function cleanClone(box: Sandbox): void {
  const remote = join(box.dir, '..', 'remote.git');
  box.git('-c', 'user.email=octocat@example.invalid', '-c', 'user.name=Octo Cat', 'commit', '--allow-empty', '-m', 'first');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', '-u', 'origin', 'main');
}

describe('the prompt library stays inside the wizard', () => {
  test('the pattern recognises every form of import', () => {
    for (const form of ["import * as p from '@clack/prompts';", 'import "@clack/prompts";',
      "export { text } from '@clack/prompts';", "await import('@clack/prompts')"]) {
      assert.ok(CLACK_IMPORT.test(form), form);
    }
    assert.ok(!CLACK_IMPORT.test('// drawn with @clack/prompts'), 'a comment is not an import');
  });

  test('only src/wizard/clack.ts imports @clack', () => {
    const importing = sources().filter((file) => CLACK_IMPORT.test(readFileSync(join(SRC, file), 'utf8')));
    assert.deepEqual(importing.filter((file) => file !== 'wizard/clack.ts'), []);
  });

  // The hook runs the installed CLI (ADR-003): a broken or missing dependency must
  // never be able to stop `guard check` or any other command. So they run here with
  // a resolver that fails the moment anything asks for the clack adapter or @clack.
  test('every command but setup runs without resolving clack', () => {
    const probe = spawnSync(process.execPath, ['--import', NO_CLACK, '--input-type=module', '-e',
      "await import('./src/wizard/clack.ts').catch((error) => console.error(error.message));"], { encoding: 'utf8' });
    assert.match(probe.stderr, /clack was resolved/, 'the hook must catch a load of the adapter');
    const box = sandbox();
    try {
      for (const args of [['--help'], ['help', 'guard'], ['help', 'setup'], ['setup'], [], ['doctor'], ['guard', 'status'], ['accounts', 'list'],
        ['guard', 'check', '--remote', 'origin', '--url', 'https://github.com/octocat/x.git'],
        ['scan'], ['fix', '--dry-run'], ['use', 'octocat'], ['guard', 'on'], ['guard', 'off'], ['off']]) {
        const run = spawnSync(process.execPath, ['--import', NO_CLACK, CLI, ...args],
          { cwd: box.dir, input: '', env: { ...process.env, REPOWN_CONFIG_DIR: join(box.dir, '..', 'registry') }, encoding: 'utf8' });
        assert.doesNotMatch(run.stderr, /clack was resolved/, args.join(' '));
      }
    } finally {
      box.dispose();
    }
  });
});

/** A module hook, preloaded with --import, that throws when clack is resolved. */
const NO_CLACK = 'data:text/javascript,' + encodeURIComponent(
  "import { registerHooks } from 'node:module';" +
  'registerHooks({ resolve(specifier, context, next) {' +
  "  if (specifier.startsWith('@clack/') || /(^|[\\\\/])clack\\.ts$/.test(specifier))" +
  "    throw new Error('clack was resolved: ' + specifier);" +
  '  return next(specifier, context);' +
  '} });');

describe('fix preview lines', () => {
  test('are the dry-run preview, one string per line, for the wizard to show on stderr', async () => {
    const { previewLines } = await import('../src/commands/fix.ts');
    const lines = previewLines([{ scope: 'global', key: 'credential.https://github.com.helper', values: ['!gh auth git-credential'], removed: false }]);
    assert.deepEqual(lines, [
      '',
      '  These entries make gh the credential helper, and will be removed:',
      '',
      '    global:  credential.https://github.com.helper',
      '        = !gh auth git-credential',
      '',
      '  Nothing else in your config is touched.',
      '  Undo at any time:  gh auth setup-git',
      '',
    ]);
  });
});
