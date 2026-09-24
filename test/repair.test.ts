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

  const helpers = (...values: string[]): void => box.writeGlobalConfig(
    '[credential "https://github.com"]\n' + values.map((value) => '\thelper = ' + value + '\n').join(''));
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

  test('beside gh, another helper on the same key survives the repair', async () => {
    helpers('', GH, '!/opt/corp/helper --sso');
    const planned = await planRepair(git);
    assert.deepEqual(planned[0]!.values, ['', GH], 'only gh and its reset are listed for removal');
    await repair(git);
    assert.deepEqual(await remaining(), ['!/opt/corp/helper --sso']);
  });
});
