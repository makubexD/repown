// `repown doctor`'s account list: the union of the registry, GCM and gh, and
// what each cell is allowed to claim. The spawn test locks the whole layout.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';
import { ok, err } from '../src/core/result.ts';
import { registryPath, type Account, type Registry } from '../src/core/registry.ts';
import type { Result } from '../src/core/result.ts';
import {
  accountRows, formatAccountLines, type AccountReport, type DoctorAuth,
} from '../src/commands/doctor.ts';
import { activeAccountLabel, type AuthState } from '../src/core/inspect.ts';
import { displayPath } from '../src/ui/format.ts';
import { ghStateFrom } from '../src/core/credential/gh.ts';
import { GH_EMPTY_HOSTS } from './fixtures/gh-empty-hosts.ts';

for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

const GITHUB: Account = { name: 'Octo Cat', email: 'octocat@example.invalid' };
const NOT_YET = 'not signed in yet (the first push signs in)';
const HOST_SIGN_IN = 'your host\'s own sign-in';
const STORED_UNUSED = 'stored in Git Credential Manager, which git isn\'t using';
const NO_GCM = '  no accounts recorded or signed in to gh; Git Credential Manager isn\'t installed';

function registry(accounts: Readonly<Record<string, Account>>): Result<Registry> {
  return ok({ accounts, unreadable: [] });
}

function auth(overrides: Partial<DoctorAuth> = {}): DoctorAuth {
  return {
    gcmPresent: true,
    stored: ok([]),
    ghPresent: true,
    gh: ok({ accounts: [], active: null }),
    helperIsGcm: true,
    ...overrides,
  };
}

function named(report: AccountReport, name: string): AccountReport['rows'][number] {
  const found = report.rows.find((item) => item.name === name);
  assert.ok(found, name + ' missing from ' + report.rows.map((item) => item.name).join(', '));
  return found;
}

describe('accountRows: who is listed', () => {
  test('registry order first, then GCM and gh together, alphabetically', () => {
    const report = accountRows(registry({
      'octo-work': GITHUB,
      octocat: GITHUB,
    }), auth({
      stored: ok(['octo-org', 'octo-work']),
      gh: ok({ accounts: [{ login: 'octocat', active: false }], active: null }),
    }), null);
    assert.deepEqual(report.rows.map((item) => item.name), ['octo-work', 'octocat', 'octo-org']);
  });

  test('the same account in another case is one row, registry spelling first', () => {
    const report = accountRows(registry({ OctoCat: GITHUB }), auth({
      stored: ok(['octocat']),
      gh: ok({
        accounts: [{ login: 'OCTOCAT', active: true }],
        active: 'OCTOCAT',
      }),
    }), null);
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0]!.name, 'OctoCat');
    assert.equal(report.rows[0]!.git, 'stored');
    assert.equal(report.rows[0]!.gh, 'active');
    assert.equal(report.rows[0]!.recorded, 'recorded');
  });

  test('without a registry entry, GCM\'s spelling wins over gh\'s', () => {
    const report = accountRows(registry({}), auth({
      stored: ok(['Octo-Work']),
      gh: ok({
        accounts: [{ login: 'octo-work', active: true }],
        active: 'octo-work',
      }),
    }), null);
    assert.deepEqual(report.rows.map((item) => item.name), ['Octo-Work']);
    assert.equal(report.rows[0]!.recorded, 'absent');
  });
});

describe('accountRows: git cell', () => {
  test('stored, not signed in yet, and unknown are different answers', () => {
    const stored = accountRows(registry({ octocat: GITHUB }), auth({ stored: ok(['octocat']) }), null);
    const absent = accountRows(registry({ octocat: GITHUB }), auth({ stored: ok([]) }), null);
    const unread = accountRows(registry({ octocat: GITHUB }), auth({
      gcmPresent: true, stored: err('github list failed'),
    }), null);
    const missing = accountRows(registry({ octocat: GITHUB }), auth({
      gcmPresent: false, stored: err('Git Credential Manager is not installed'),
    }), null);
    assert.equal(stored.rows[0]!.git, 'stored');
    assert.equal(absent.rows[0]!.git, NOT_YET);
    assert.equal(unread.rows[0]!.git, 'unknown');
    assert.equal(missing.rows[0]!.git, 'unknown');
  });

  // "The first push signs in" is a promise that GCM will do it. gh as the
  // helper will not. An account the store does hold is said to live there,
  // and not to be what git will use.
  test('a missing account is unknown when GCM is not the helper', () => {
    const held = accountRows(registry({ octocat: GITHUB }), auth({
      stored: ok(['Octocat']), helperIsGcm: false,
    }), null);
    const missing = accountRows(registry({ octocat: GITHUB }), auth({
      stored: ok([]), helperIsGcm: false,
    }), null);
    assert.equal(held.rows[0]!.git, STORED_UNUSED);
    assert.equal(missing.rows[0]!.git, 'unknown');
    assert.notEqual(missing.rows[0]!.git, NOT_YET);
  });
});

describe('accountRows: gh cell', () => {
  test('active, signed in, and not signed in', () => {
    const report = accountRows(registry({
      octocat: GITHUB,
      'octo-org': GITHUB,
      'octo-work': GITHUB,
    }), auth({
      gh: ok({
        accounts: [
          { login: 'octocat', active: true },
          { login: 'octo-org', active: false },
        ],
        active: 'octocat',
      }),
    }), null);
    assert.equal(named(report, 'octocat').gh, 'active');
    assert.equal(named(report, 'octo-org').gh, 'signed in');
    assert.equal(named(report, 'octo-work').gh, 'not signed in');
  });

  test('gh could not be queried, so the cell is unknown', () => {
    const report = accountRows(registry({ octocat: GITHUB }), auth({
      ghPresent: true, gh: err('gh auth status failed'),
    }), null);
    assert.equal(report.rows[0]!.gh, 'unknown');
  });

  test('gh not installed is not repeated on the row', () => {
    const report = accountRows(registry({ octocat: GITHUB }), auth({
      ghPresent: false, gh: err('gh is not installed'),
    }), null);
    assert.equal(report.rows[0]!.gh, null);
    assert.equal(report.warnings.length, 0);
  });
});

describe('accountRows: marks and hosts', () => {
  test('the pinned account is this clone, in any case; no pin marks nothing', () => {
    const report = accountRows(registry({
      Octocat: GITHUB,
      'octo-org': GITHUB,
    }), auth(), 'octocat');
    assert.equal(named(report, 'Octocat').thisClone, true);
    assert.equal(named(report, 'octo-org').thisClone, false);
    const outside = accountRows(registry({ octocat: GITHUB }), auth(), null);
    assert.equal(outside.rows[0]!.thisClone, false);
  });

  test('an account only GCM or gh knows is not recorded by repown', () => {
    const report = accountRows(registry({}), auth({ stored: ok(['octo-work']) }), null);
    assert.equal(report.rows[0]!.recorded, 'absent');
    assert.match(formatAccountLines(report)[0]!, /not recorded by repown/);
  });

  test('a non-GitHub account uses its host\'s sign-in and has no gh cell', () => {
    const report = accountRows(registry({
      'octo-work': { name: 'Octo Work', email: 'octo-work@example.invalid', host: 'azdo' },
    }), auth({
      stored: ok(['octo-work']),
      gh: ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' }),
    }), 'octo-work');
    const row = report.rows[0]!;
    assert.equal(row.git, HOST_SIGN_IN);
    assert.equal(row.gh, null);
    assert.equal(row.thisClone, true);
    assert.equal(formatAccountLines(report)[0],
      '  ' + 'octo-work'.padEnd(14) + ' (this clone)  git: ' + HOST_SIGN_IN);
  });
});

describe('accountRows: a source that could not be read', () => {
  test('registry, store and gh each warn once, and cells that depend on them are unknown', () => {
    const report = accountRows(err('could not read accounts.json'), auth({
      stored: ok(['octo-work']),
      gh: ok({ accounts: [{ login: 'octo-work', active: true }], active: 'octo-work' }),
    }), 'octo-work');
    const row = named(report, 'octo-work');
    assert.equal(row.recorded, 'unknown');
    assert.equal(row.git, 'stored');
    assert.equal(row.gh, 'active');
    assert.equal(report.none, false);
    assert.deepEqual(report.warnings, [{
      tag: 'account',
      message: 'the account registry could not be read, so recorded accounts are unknown.',
      detail: 'see: repown accounts list',
    }]);
    assert.match(formatAccountLines(report)[0]!, /recorded: unknown/);
    assert.doesNotMatch(formatAccountLines(report)[0]!, /not recorded by repown/);
  });

  test('a store that could not be listed warns, and a missing GCM does not', () => {
    const unread = accountRows(registry({ octocat: GITHUB }), auth({
      stored: err('github list failed'),
    }), null);
    assert.equal(unread.rows[0]!.git, 'unknown');
    assert.deepEqual(unread.warnings, [{
      tag: 'store',
      message: 'stored accounts could not be read: github list failed',
      detail: null,
    }]);
    const absent = accountRows(registry({ octocat: GITHUB }), auth({
      gcmPresent: false, stored: err('Git Credential Manager is not installed'),
    }), null);
    assert.equal(absent.warnings.length, 0);
  });

  test('gh that could not be queried warns', () => {
    const report = accountRows(registry({ octocat: GITHUB }), auth({
      gh: err('gh auth status failed'),
    }), null);
    assert.deepEqual(report.warnings, [{
      tag: 'gh',
      message: 'could not be queried (gh auth status failed), so signed-in accounts are unknown.',
      detail: 'check it yourself: gh auth status',
    }]);
  });

  test('three failures are three warnings, in source order, and not "none"', () => {
    const report = accountRows(err('broken'), auth({
      stored: err('github list failed'),
      gh: err('gh auth status failed'),
    }), null);
    assert.deepEqual(report.warnings.map((warning) => warning.tag), ['account', 'store', 'gh']);
    assert.equal(report.none, false);
    assert.deepEqual(formatAccountLines(report), []);
  });
});

describe('accountRows: nothing to list', () => {
  test('an empty machine points at repown setup', () => {
    const report = accountRows(registry({}), auth(), null);
    assert.equal(report.none, true);
    assert.deepEqual(formatAccountLines(report), [
      '  none recorded, stored or signed in yet',
      '  repown setup',
    ]);
  });

  test('gh not installed is still an empty gh list', () => {
    const report = accountRows(registry({}), auth({
      ghPresent: false, gh: err('gh is not installed'),
    }), null);
    assert.equal(report.none, true);
  });

  test('GCM not installed is not an empty store', () => {
    const report = accountRows(registry({}), auth({
      gcmPresent: false, stored: err('Git Credential Manager is not installed'),
    }), null);
    assert.equal(report.none, false);
    assert.equal(report.gcmMissing, true);
    assert.deepEqual(formatAccountLines(report), [NO_GCM, '  repown setup']);
  });

  test('GCM not installed does not describe a gh query that failed as an empty list', () => {
    const report = accountRows(registry({}), auth({
      gcmPresent: false,
      stored: err('Git Credential Manager is not installed'),
      gh: err('gh auth status failed'),
    }), null);
    assert.equal(report.none, false);
    assert.equal(report.gcmMissing, false);
    assert.deepEqual(formatAccountLines(report), []);
  });

  test('the empty hosts fixture is gh active none and not signed in, with no gh warning', () => {
    const parsed = ghStateFrom({ code: 0, stdout: GH_EMPTY_HOSTS, stderr: '' });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const report = accountRows(registry({ octocat: GITHUB }), auth({ gh: parsed }), 'octocat');
    assert.equal(report.rows[0]!.gh, 'not signed in');
    assert.deepEqual(report.warnings, []);
    assert.match(formatAccountLines(report)[0]!, /gh: not signed in/);
    assert.equal(activeAccountLabel(fullAuth(parsed)), 'none');
  });

  test('names line up the way a status field does', () => {
    const report = accountRows(registry({ octocat: GITHUB }), auth({ stored: ok([]) }), 'octocat');
    const value = '(this clone)  git: ' + NOT_YET + ' · gh: not signed in';
    assert.equal(formatAccountLines(report)[0], '  ' + 'octocat'.padEnd(14) + ' ' + value);
  });
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function repown(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, input: '', env, encoding: 'utf8' });
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr };
}

function field(label: string, value: string): string {
  return '  ' + label.padEnd(14) + ' ' + value;
}

const SSO_HEAD = 'If a push fails although the account is stored, the org may need SSO\n  authorization: ';
const GITHUB_SSO = SSO_HEAD + "authorize it in the org's SSO settings on github.com";
const READY = 'ready: each clone signs in as its own account through Git Credential Manager';

function ssoFor(host: string): string {
  return SSO_HEAD + 'check ' + host + '\'s SSO settings';
}

/** The last stderr line, which must stand after a blank line. */
function closing(stderr: string): string {
  const lines = stderr.split('\n');
  assert.equal(lines.at(-1), '', stderr);
  assert.equal(lines.at(-3), '', stderr);
  return lines.at(-2) ?? '';
}

function fullAuth(gh: AuthState['gh']): AuthState {
  return {
    gcmPath: null, gcmPresent: true, stored: ok([]), ghPresent: true, gh,
    helper: 'manager', ghIsHelper: false, helperIsGcm: true, ghHelperOrigins: [],
  };
}

describe('repown doctor output', () => {
  let box: Sandbox;
  let bin: string;

  beforeEach(() => {
    box = sandbox();
    bin = join(box.dir, '..', 'fake-bin');
    mkdirSync(bin);
    installFakes(bin);
    writeRegistry();
    box.git('remote', 'add', 'origin', 'https://github.com/octocat/project.git');
    box.git('config', '--local', 'repown.account', 'octocat');
    box.git('config', '--local', 'credential.https://github.com.username', 'octocat');
    box.writeGlobalConfig('[credential]\n\thelper = manager\n');
  });
  afterEach(() => box.dispose());

  test('machine, accounts, the short SSO reminder, then a ready verdict', () => {
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, [
      '',
      'repown doctor · how this machine signs in to git hosts',
      '',
      'This machine',
      field('helper', 'manager'),
      field('GCM', displayPath('git-credential-manager')),
      field('gh active', 'octo-work'),
      '',
      'Accounts',
      field('octocat', '(this clone)  git: ' + NOT_YET + ' · gh: not signed in'),
      field('octo-work', 'not recorded by repown · git: stored · gh: active'),
      '',
      '  Credentials come from Git Credential Manager, which stores one per',
      '  account and picks per repository from credential.<url>.username. No',
      '  switching is needed for git, and `gh auth switch` affects the CLI only.',
      '',
      '  ' + GITHUB_SSO,
    ].join('\n') + '\n');
    assert.equal(closing(run.stderr), READY);
    assert.doesNotMatch(run.stdout, /SSO-authorized for that organisation/);
    assert.doesNotMatch(run.stdout, /<host>|gh auth refresh/);

    const outside = repown(['doctor'], join(box.dir, '..'), doctorEnv(bin));
    assert.equal(outside.status, 0, outside.stderr);
    assert.match(outside.stdout, /repown doctor · how this machine signs in to git hosts/);
    assert.match(outside.stdout, /octocat/);
    assert.doesNotMatch(outside.stdout, /this clone/);
    assert.ok(outside.stdout.includes('  ' + GITHUB_SSO), outside.stdout);
    assert.doesNotMatch(outside.stdout, /<host>|gh auth refresh/);
    assert.equal(closing(outside.stderr), READY);
  });

  test('a GitHub origin and a run outside a clone name github.com in the SSO line', () => {
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.match(run.stdout, / {2}authorization: authorize it in the org's SSO settings on github\.com/);
    assert.doesNotMatch(run.stdout, /<host>|gh auth refresh/);
    const outside = repown(['doctor'], join(box.dir, '..'), doctorEnv(bin));
    assert.match(outside.stdout, / {2}authorization: authorize it in the org's SSO settings on github\.com/);
    assert.doesNotMatch(outside.stdout, /<host>|gh auth refresh/);
  });

  test('a non-GitHub origin names that host\'s SSO settings', () => {
    box.git('remote', 'set-url', 'origin', 'https://dev.azure.com/octocat/project/_git/repo');
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('  ' + ssoFor('Azure DevOps')), run.stdout);
    assert.doesNotMatch(run.stdout, /<host>|gh auth refresh/);
    assert.equal(closing(run.stderr), READY);
  });

  test('an empty store stays a warning and says so in the verdict', () => {
    const run = repown(['doctor'], box.dir, { ...doctorEnv(bin), GCM_FAKE_EMPTY: '1' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stderr.includes('WARN  store      no accounts stored yet -- the first push will sign in once.'), run.stderr);
    assert.ok(run.stdout.includes('  ' + GITHUB_SSO), run.stdout);
    assert.equal(closing(run.stderr), 'ready · no accounts stored yet: the first push signs in once');
  });

  test('gh as the helper exits 1 and the verdict names repown fix', () => {
    box.writeGlobalConfig('[credential]\n\thelper = !gh auth git-credential\n');
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /FAIL {2}helper/);
    assert.match(run.stdout, /fix: repown fix/);
    assert.doesNotMatch(run.stdout, /SSO authorization/);
    assert.equal(closing(run.stderr), '1 problem: gh answers git\'s sign-in requests: run repown fix');
  });

  test('an unknown helper exits 0 and the verdict says the pin is unchecked', () => {
    box.writeGlobalConfig('[credential]\n\thelper = store\n');
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}helper/);
    assert.doesNotMatch(run.stdout, /SSO authorization/);
    assert.equal(closing(run.stderr), 'unchecked: repown can\'t tell whether store honours the per-clone pin');
  });

  test('a source that could not be read is counted in the verdict, as status counts it', () => {
    const path = registryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{');
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /WARN {2}account {4}the account registry could not be read/);
    assert.equal(closing(run.stderr), READY + ' · 1 warning');
  });

  test('no helper is unchecked the same way, naming nothing', () => {
    box.writeGlobalConfig('');
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(closing(run.stderr), 'unchecked: repown can\'t tell whether nothing honours the per-clone pin');
  });

  test('a gh signed in to nobody is none and not signed in, with no gh warning', () => {
    const file = join(box.dir, '..', 'gh-empty-hosts.txt');
    writeFileSync(file, GH_EMPTY_HOSTS);
    const run = repown(['doctor'], box.dir, { ...doctorEnv(bin), GH_FAKE_STATUS_FILE: file });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(closing(run.stderr), READY);
    assert.doesNotMatch(run.stderr, /WARN/);
    assert.match(run.stdout, /gh active\s+none/);
    assert.match(run.stdout, /octocat.*gh: not signed in/);
    assert.doesNotMatch(run.stdout, /unknown -- gh could not be queried/);
    assert.doesNotMatch(run.stderr, /WARN/);
  });
});

function writeRegistry(): void {
  const dir = process.env['REPOWN_CONFIG_DIR'] ?? join(tmpdir(), 'missing-repown-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify({
    accounts: { octocat: { name: 'Octo Cat', email: 'octocat@example.invalid' } },
  }));
}

function doctorEnv(bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + delimiter + (process.env['PATH'] ?? '') };
  delete env['FORCE_COLOR'];
  delete env['NO_COLOR'];
  env['TERM'] = 'dumb';
  return env;
}

function installFakes(bin: string): void {
  if (process.platform === 'win32') {
    compile(bin, 'gh.exe', FAKE_GH_CS);
    compile(bin, 'git-credential-manager.exe', FAKE_GCM_CS);
    return;
  }
  writeFileSync(join(bin, 'gh'), FAKE_GH_SH, { mode: 0o755 });
  writeFileSync(join(bin, 'git-credential-manager'), FAKE_GCM_SH, { mode: 0o755 });
}

function compile(bin: string, out: string, source: string): void {
  const file = join(bin, out.replace(/\.exe$/, '.cs'));
  writeFileSync(file, source);
  const run = spawnSync(cscPath(), ['/nologo', '/out:' + join(bin, out), file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
}

function cscPath(): string {
  const root = join(process.env['WINDIR'] ?? 'C:\\Windows', 'Microsoft.NET');
  const found = ['Framework64', 'Framework']
    .map((name) => join(root, name, 'v4.0.30319', 'csc.exe'))
    .find((path) => existsSync(path));
  if (!found) throw new Error('csc.exe is not installed');
  return found;
}

const FAKE_GH_CS = `
using System;
using System.IO;
class FakeGh {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("gh version 2.88.1");
      return 0;
    }
    if (args.Length >= 2 && args[0] == "auth" && args[1] == "status") {
      var file = Environment.GetEnvironmentVariable("GH_FAKE_STATUS_FILE");
      if (!string.IsNullOrEmpty(file)) {
        Console.Write(File.ReadAllText(file));
        return 0;
      }
      Console.WriteLine("{\\"hosts\\":{\\"github.com\\":[{\\"login\\":\\"octo-work\\",\\"active\\":true}]}}");
      return 0;
    }
    return 97;
  }
}
`;

const FAKE_GCM_CS = `
using System;
class FakeGcm {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("fake-gcm");
      return 0;
    }
    if (args.Length == 2 && args[0] == "github" && args[1] == "list") {
      if (Environment.GetEnvironmentVariable("GCM_FAKE_EMPTY") == "1") return 0;
      Console.WriteLine("octo-work");
      return 0;
    }
    return 97;
  }
}
`;

const FAKE_GH_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.88.1"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$GH_FAKE_STATUS_FILE" ]; then cat "$GH_FAKE_STATUS_FILE"; exit 0; fi
  echo '{"hosts":{"github.com":[{"login":"octo-work","active":true}]}}'
  exit 0
fi
exit 97
`;

const FAKE_GCM_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo fake-gcm; exit 0; fi
if [ "$1" = "github" ] && [ "$2" = "list" ]; then
  if [ "$GCM_FAKE_EMPTY" = "1" ]; then exit 0; fi
  echo octo-work; exit 0
fi
exit 97
`;
