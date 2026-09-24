// `repown fix` removes what `gh auth setup-git` wrote -- and only that. It edits
// global (and possibly system) config, so taking anything else with it is not
// a cosmetic slip: a deliberate per-host helper is gone, and `gh auth setup-git`,
// the documented undo, does not bring it back.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { planRepair, repair } from '../src/core/credential/repair.ts';

const KEY = 'credential.https://github.com.helper';
const GH = '!gh auth git-credential';

describe('repown fix: what it plans and what it removes', () => {
  let box: Sandbox;
  let git: Git;
  beforeEach(() => { box = sandbox(); git = new Git(box.dir); });
  afterEach(() => box.dispose());

  /** Written through git itself, so values with backslashes or quotes are stored exactly. */
  const helpers = (...values: string[]): void => {
    box.writeGlobalConfig('');
    for (const value of values) box.git('config', '--global', '--add', KEY, value);
  };
  const remaining = (): Promise<string[]> => git.getAllConfigRaw(KEY, 'global');

  test('what `gh auth setup-git` wrote -- the reset and gh -- is planned and removed', async () => {
    helpers('', GH);
    const planned = await planRepair(git);
    assert.equal(planned.length, 1);
    assert.deepEqual(planned[0]!.values, ['', GH]);
    const results = await repair(git);
    assert.ok(results.every((result) => result.removed));
    assert.deepEqual(await remaining(), []);
  });

  test('a per-host helper that is not gh is not planned at all', async () => {
    helpers('manager');
    assert.deepEqual(await planRepair(git), []);
  });

  test('only gh itself counts: a composite helper or another CLI is left alone', async () => {
    helpers('!gh auth git-credential | manager');
    assert.deepEqual(await planRepair(git), [], 'a composite helper is not what gh wrote');
    helpers('!glab auth git-credential');
    assert.deepEqual(await planRepair(git), []);
  });

  test('the path form gh writes on Windows is recognised', async () => {
    helpers('', "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential");
    assert.equal((await planRepair(git)).length, 1);
  });

  test('an empty reset NOT directly before gh is not gh\'s, and stays', async () => {
    helpers('', '!/opt/corp/helper', '', GH);
    const planned = await planRepair(git);
    assert.deepEqual(planned[0]!.values, ['', GH]);
    await repair(git);
    assert.deepEqual(await remaining(), ['', '!/opt/corp/helper']);
  });

  test('beside gh, another helper on the same key survives the repair', async () => {
    helpers('', GH, '!/opt/corp/helper --sso');
    const planned = await planRepair(git);
    assert.deepEqual(planned[0]!.values, ['', GH], 'only gh and its reset are listed for removal');
    await repair(git);
    assert.deepEqual(await remaining(), ['!/opt/corp/helper --sso']);
  });
});
