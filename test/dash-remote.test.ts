// A remote whose name starts with "-" (set by hand in config) reaches git after `--`, so git
// reads it as the remote, never as an option (ADR-026). Measured: without `--`, `git fetch -x`
// is "unknown switch `x'".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Git } from '../src/core/git.ts';
import { gitStepOf } from '../src/wizard/setup-flow.ts';
import { sandbox } from './helpers.ts';

test('fetch and ls-remote reach a remote named -x', async () => {
  const box = sandbox();
  try {
    const bare = join(box.dir, '..', 'up.git');
    box.git('init', '-q', '--bare', bare);
    box.git('-c', 'user.name=Octo Cat', '-c', 'user.email=octocat@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x');
    box.git('push', '-q', bare, 'HEAD:refs/heads/main');
    box.git('config', 'remote.-x.url', bare);
    box.git('config', 'remote.-x.fetch', '+refs/heads/*:refs/remotes/-x/*');
    const git = new Git(box.dir);
    assert.deepEqual(await git.fetchQuietly('-x'), { ok: true, value: undefined });
    assert.deepEqual(await git.remoteHeadCount('-x'), { ok: true, value: 1 });
    const tips = await git.remoteTips('-x');
    assert.ok(tips.ok && tips.value.heads.length === 1, JSON.stringify(tips));
  } finally {
    box.dispose();
  }
});

test('setup shows its fetch of a remote named -x with --, and still reads it as the fetch step', () => {
  assert.equal(gitStepOf(['git', 'fetch', '--', '-x']), 'fetch');
  assert.equal(gitStepOf(['git', '-C', 'repo', 'fetch', '--', '-x']), 'fetch');
  assert.equal(gitStepOf(['git', 'fetch', 'origin']), 'fetch');
});
