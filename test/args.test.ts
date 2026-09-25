// The parser is what stands between a typo and a command doing the wrong
// thing quietly: a boolean must never swallow the next positional, an
// unknown option must never be dropped, and an option's value is validated
// against its declared choices before a command ever sees it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, hasHelpFlag, type Spec } from '../src/ui/args.ts';

const spec = (over: Partial<Spec> = {}): Spec => ({
  options: [
    { name: 'gh', kind: 'boolean', help: 'switch too' },
    { name: 'name', kind: 'string', help: 'a name' },
    { name: 'host', kind: 'string', default: 'github', choices: ['github', 'azdo'], help: 'a host' },
  ],
  positionals: { min: 1, max: 1, label: '<account>' },
  ...over,
});

describe('parseArgs', () => {
  // `repown use -x` used to pin an account literally named "-x".
  test('a single-dash token is refused as an unknown option, not taken as a positional', () => {
    const result = parseArgs(['-x'], spec());
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /unknown option -x/);
  });

  test('a bare - is a positional only where the command declares it reads stdin', () => {
    const result = parseArgs(['-'], spec({ positionals: { min: 1, max: 1, stdin: true } }));
    assert.ok(result.ok);
    assert.deepEqual(result.value.positional, ['-']);
  });

  // 0.1.0 accepted a bare - everywhere, so `repown use -` pinned an account named "-".
  test('elsewhere a bare - is still an unknown option', () => {
    const result = parseArgs(['-'], spec({ positionals: { min: 1, max: 1 } }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /unknown option -/);
  });

  test('after --, a dash-led value is still a positional', () => {
    const result = parseArgs(['--', '-x'], spec());
    assert.ok(result.ok);
    assert.deepEqual(result.value.positional, ['-x']);
  });

  test('a boolean option never consumes the next token', () => {
    const result = parseArgs(['--gh', 'octocat'], spec());
    assert.ok(result.ok);
    assert.equal(result.value.flags.get('gh'), true);
    assert.deepEqual(result.value.positional, ['octocat']);
  });

  test('a string option takes the next token as its value', () => {
    const result = parseArgs(['octocat', '--name', 'Octo Cat'], spec());
    assert.ok(result.ok);
    assert.equal(result.value.flags.get('name'), 'Octo Cat');
  });

  test('--name=value is accepted inline', () => {
    const result = parseArgs(['octocat', '--name=Octo Cat'], spec());
    assert.ok(result.ok);
    assert.equal(result.value.flags.get('name'), 'Octo Cat');
  });

  test('an unknown option is refused, not silently dropped', () => {
    const result = parseArgs(['octocat', '--emial', 'x'], spec());
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /unknown option --emial/);
  });

  test('an unknown option close to a real one is corrected', () => {
    const result = parseArgs(['octocat', '--emial', 'x'], spec({
      options: [...spec().options, { name: 'email', kind: 'string', help: 'an email' }],
    }));
    assert.match((result as { error: string }).error, /did you mean --email\?/);
  });

  test('a value outside the declared choices is refused', () => {
    const result = parseArgs(['octocat', '--host', 'nope'], spec());
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /--host must be one of: github, azdo/);
  });

  test('a default fills in when the option is not given', () => {
    const result = parseArgs(['octocat'], spec());
    assert.ok(result.ok);
    assert.equal(result.value.flags.get('host'), 'github');
  });

  test('too few positionals is refused', () => {
    const result = parseArgs([], spec());
    assert.equal(result.ok, false);
  });

  test('too many positionals names the extra argument', () => {
    const result = parseArgs(['a', 'b'], spec());
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /unexpected argument: 'b'/);
  });

  test('-- ends option parsing, so a positional may start with a dash', () => {
    const result = parseArgs(['--', '--not-an-option'], spec());
    assert.ok(result.ok);
    assert.deepEqual(result.value.positional, ['--not-an-option']);
  });

  test('--cwd is accepted on every command via the global options', () => {
    const result = parseArgs(['octocat', '--cwd', '/tmp/repo'], spec());
    assert.ok(result.ok);
    assert.equal(result.value.flags.get('cwd'), '/tmp/repo');
  });

  test('a variadic positional accepts any count within range', () => {
    const result = parseArgs(['a', 'b', 'c'], spec({ positionals: { min: 0, max: Infinity } }));
    assert.ok(result.ok);
    assert.deepEqual(result.value.positional, ['a', 'b', 'c']);
  });
});

describe('hasHelpFlag', () => {
  test('true when --help appears before a -- marker', () => {
    assert.equal(hasHelpFlag(['on', '--help']), true);
    assert.equal(hasHelpFlag(['-h']), true);
  });

  test('false once -- has ended option parsing', () => {
    assert.equal(hasHelpFlag(['--', '--help']), false);
  });

  test('false when there is no help flag at all', () => {
    assert.equal(hasHelpFlag(['on', '--yes']), false);
  });
});
