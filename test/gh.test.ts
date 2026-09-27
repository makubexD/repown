// The github.com profile lookup. `--hostname` keeps GH_HOST from sending it elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ghProfileArgs } from '../src/core/credential/gh.ts';

test('a github.com profile lookup names the host, so GH_HOST cannot redirect it', () => {
  assert.deepEqual(
    ghProfileArgs('octocat', 'type'),
    ['api', '--hostname', 'github.com', 'users/octocat', '--jq', '.type'],
  );
  assert.deepEqual(
    ghProfileArgs('octo-org', 'name'),
    ['api', '--hostname', 'github.com', 'users/octo-org', '--jq', '.name'],
  );
  const source = readFileSync(new URL('../src/core/credential/gh.ts', import.meta.url), 'utf8');
  assert.match(source, /run\('gh', ghProfileArgs\(login, field\)\)/);
});
