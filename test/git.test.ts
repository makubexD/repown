import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';

describe('Git', () => {
  let box: Sandbox;
  let git: Git;

  before(() => { box = sandbox(); git = new Git(box.dir); });
  after(() => box.dispose());

  test('an unset key is an ANSWER, not a failure', async () => {
    assert.equal(await git.getConfig('no.such.key'), null);
  });

  test('reads a key that is set', async () => {
    box.git('config', '--local', 'gid.probe', 'value');
    assert.equal(await git.getConfig('gid.probe'), 'value');
  });

  test('unsetting an absent key succeeds rather than erroring', async () => {
    assert.equal(await git.unsetConfig('never.existed'), true);
  });

  test('getAllConfig returns every value of a multi-valued key', async () => {
    box.git('config', '--local', '--add', 'gid.multi', 'one');
    box.git('config', '--local', '--add', 'gid.multi', 'two');
    assert.deepEqual(await git.getAllConfig('gid.multi'), ['one', 'two']);
  });

  test('an empty credential helper RESETS the list, discarding what came before', async () => {
    // Exactly what `gh auth setup-git` writes. The empty value is defined by
    // gitcredentials(7) as a list reset, so `manager` must NOT survive it.
    box.writeGlobalConfig([
      '[credential]',
      '\thelper = manager',
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !gh auth git-credential',
      '',
    ].join('\n'));

    const effective = await git.getUrlMatch('credential.helper', 'https://github.com/');
    assert.ok(effective !== null, 'a helper must resolve');
    assert.ok(!/manager/.test(effective), `manager must be discarded, got: ${effective}`);
    assert.match(effective, /gh auth git-credential/);
  });

  test('without the reset, the configured helper survives', async () => {
    box.writeGlobalConfig('[credential]\n\thelper = manager\n');
    const effective = await git.getUrlMatch('credential.helper', 'https://github.com/');
    assert.equal(effective, 'manager');
  });

  test('reads author and committer of each commit in a range', async () => {
    box.git('commit', '--allow-empty', '-m', 'first');
    box.git('-c', 'user.email=other@example.invalid',
            'commit', '--allow-empty', '-m', 'second');

    const found = await git.identitiesIn(['HEAD']);
    assert.equal(found.length, 2);
    assert.equal(found[0]?.subject, 'second');
    assert.equal(found[0]?.authorEmail, 'other@example.invalid');
    assert.equal(found[1]?.authorEmail, 'sandbox@example.invalid');
  });

  test('commonDir resolves, and is where hooks live', async () => {
    const common = await git.commonDir();
    assert.ok(common && common.length > 0);
  });

  test('isRepo is false outside a repository', async () => {
    assert.equal(await new Git(box.dir + '/../').isRepo(), false);
  });
});

describe('empty config values', () => {
  let box: Sandbox;
  before(() => { box = sandbox(); });
  after(() => box.dispose());

  test('an EMPTY helper value is preserved, because it is the list reset', async () => {
    // This is exactly what `gh auth setup-git` writes. Dropping the blank made
    // `gid fix` preview half of what it was about to remove, and hid the line
    // that explains why credentials broke.
    box.writeGlobalConfig([
      '[credential "https://github.com"]',
      '\thelper = ',
      '\thelper = !gh auth git-credential',
      '',
    ].join('\n'));

    const git = new Git(box.dir);
    const raw = await git.getAllConfigRaw('credential.https://github.com.helper', 'global');
    assert.equal(raw.length, 2, 'both values must survive');
    assert.equal(raw[0], '', 'the list reset is the first value');
    assert.match(raw[1]!, /gh auth git-credential/);

    // The filtering reader still drops it -- that is its job elsewhere.
    const filtered = await git.getAllConfig('credential.https://github.com.helper', 'global');
    assert.equal(filtered.length, 1);
  });
});
