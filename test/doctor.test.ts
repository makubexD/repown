// `repown doctor`'s account list: the union of the registry, GCM and gh, and
// what each cell is allowed to claim. The spawn test locks the whole layout.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { sandbox, type Sandbox } from './helpers.ts';
import { ok, err } from '../src/core/result.ts';
import type { Account, Registry } from '../src/core/registry.ts';
import type { Result } from '../src/core/result.ts';
import {
  accountRows, formatAccountLines, type AccountReport, type DoctorAuth,
} from '../src/commands/doctor.ts';

for (const name of ['FORCE_COLOR', 'NO_COLOR', 'TERM']) delete process.env[name];

const GITHUB: Account = { name: 'Octo Cat', email: 'octocat@example.invalid' };
const NOT_YET = 'not signed in yet (the first push signs in)';
const HOST_SIGN_IN = 'your host\'s own sign-in';

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
  // helper will not. An account the store does hold is still `stored`.
  test('a missing account is unknown when GCM is not the helper', () => {
    const held = accountRows(registry({ octocat: GITHUB }), auth({
      stored: ok(['Octocat']), helperIsGcm: false,
    }), null);
    const missing = accountRows(registry({ octocat: GITHUB }), auth({
      stored: ok([]), helperIsGcm: false,
    }), null);
    assert.equal(held.rows[0]!.git, 'stored');
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

  test('machine, accounts, then the unchanged diagnosis', () => {
    const run = repown(['doctor'], box.dir, doctorEnv(bin));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, [
      '',
      'repown doctor · how this machine signs in to git hosts',
      '',
      'This machine',
      field('helper', 'manager'),
      field('GCM', 'git-credential-manager'),
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
      '  If a push or fetch still fails right after this, the credential may',
      '  be valid but not yet SSO-authorized for that organisation. Re-authorize it:',
      '  gh auth refresh -h <host>, or via the org\'s SSO settings.',
      '',
    ].join('\n') + '\n');

    const outside = repown(['doctor'], join(box.dir, '..'), doctorEnv(bin));
    assert.equal(outside.status, 0, outside.stderr);
    assert.match(outside.stdout, /repown doctor · how this machine signs in to git hosts/);
    assert.match(outside.stdout, /octocat/);
    assert.doesNotMatch(outside.stdout, /this clone/);
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
class FakeGh {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("gh version 2.88.1");
      return 0;
    }
    if (args.Length >= 2 && args[0] == "auth" && args[1] == "status") {
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
  echo '{"hosts":{"github.com":[{"login":"octo-work","active":true}]}}'
  exit 0
fi
exit 97
`;

const FAKE_GCM_SH = `#!/bin/sh
if [ "$1" = "--version" ]; then echo fake-gcm; exit 0; fi
if [ "$1" = "github" ] && [ "$2" = "list" ]; then echo octo-work; exit 0; fi
exit 97
`;
