// The credential side follows the URLs git actually uses for origin, fetch and push, after
// insteadOf and pushInsteadOf: what gets pinned, which helper is judged, what off removes (ADR-009).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { inspectRepo } from '../src/core/inspect.ts';
import { readContext } from '../src/wizard/setup-context.ts';
import { Git } from '../src/core/git.ts';
import { home, record, repown, localConfig, type Home } from './wizard-setup-helpers.ts';

const KEY = 'credential.https://github.com.username';
const HTTPS = 'https://github.com/octocat/project.git';
const SSH = 'git@github.com:octocat/project.git';

/** Async, so the test's own HTTP server can answer; the helper gives a wrong password, so git fails rather than prompts. */
function pushQuietly(cwd: string): Promise<void> {
  return new Promise((done) => {
    execFile('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, () => done());
  });
}

describe('the credential side follows the URLs git uses', () => {
  let at: Home;
  beforeEach(() => {
    at = home();
    record(at, 'octocat', 'octocat@example.invalid');
  });
  afterEach(() => at.dispose());

  const inspect = () => inspectRepo(new Git(at.box.dir));
  const origin = (fetch: string, ...pushurls: string[]): void => {
    at.box.git('remote', 'add', 'origin', fetch);
    for (const url of pushurls) at.box.git('config', '--add', 'remote.origin.pushurl', url);
  };

  test('fetch and push on one URL: one key, judged on that URL, as before', async () => {
    origin(HTTPS);
    const repo = await inspect();
    assert.deepEqual(repo.credentialKeys, [KEY]);
    assert.equal(repo.credentialUrl, HTTPS);
  });

  test('measured: a push asks the helper about the push URL, with the username set for that URL', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="repown"' });
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const host = '127.0.0.1:' + (server.address() as AddressInfo).port;
      const log = join(at.box.dir, '..', 'helper.log').replace(/\\/g, '/');
      origin(SSH, 'http://' + host + '/octocat/project.git');
      at.box.git('config', 'credential.helper', '!f() { cat >> "' + log + '"; echo password=wrong; }; f');
      at.box.git('config', 'credential.http://' + host + '.username', 'octocat');
      await pushQuietly(at.box.dir);
      const asked = readFileSync(log, 'utf8');
      assert.match(asked, new RegExp('host=' + host.replace(/\./g, '\\.')));
      assert.match(asked, /username=octocat/);
    } finally {
      server.close();
    }
  });

  test('fetch over SSH, push over HTTPS: the push is pinned, and its helper is the one judged', async () => {
    origin(SSH, HTTPS);
    at.box.git('config', 'credential.https://github.com.helper', 'manager');
    const repo = await inspect();
    assert.deepEqual(repo.credentialKeys, [KEY]);
    assert.equal(repo.credentialUrl, HTTPS);
    assert.equal(repo.helper, 'manager');
  });

  test('fetch over HTTPS, push over SSH: the fetch still signs in, so the key stays', async () => {
    origin(HTTPS, SSH);
    const repo = await inspect();
    assert.deepEqual(repo.credentialKeys, [KEY]);
    assert.equal(repo.credentialUrl, HTTPS);
  });

  test('every push URL counts, not only the first', async () => {
    origin(SSH, SSH.replace('project', 'mirror'), HTTPS);
    assert.deepEqual((await inspect()).credentialKeys, [KEY]);
  });

  test('an insteadOf that sends HTTPS over SSH: nothing is pinned, and the SSH URL is the one described', async () => {
    origin(HTTPS);
    at.box.git('config', '--global', 'url.git@github.com:.insteadOf', 'https://github.com/');
    const repo = await inspect();
    assert.deepEqual(repo.credentialKeys, []);
    assert.equal(repo.credentialUrl, SSH);
    assert.equal(repo.credentialHost.id, 'github');
    const status = repown(['status'], at.box.dir);
    assert.doesNotMatch(status.stdout, /commits and pushes use/);
    assert.match(status.stdout, /not pinned by repown on GitHub/);
    assert.match(repown(['doctor'], at.box.dir).stdout, /origin is an SSH URL, so no credential is pinned here/);
  });

  test('use pins the HTTPS push of an SSH clone, setup sees the pin intact, off removes it', async () => {
    origin(SSH, HTTPS);
    assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0);
    assert.match(localConfig(at), /\[credential "https:\/\/github\.com"\]\s+username = octocat/);
    const ctx = await readContext(new Git(at.box.dir), null);
    assert.ok(ctx.ok && ctx.value.pinIntact, 'setup does not offer use again');
    assert.equal(repown(['off'], at.box.dir).status, 0);
    assert.doesNotMatch(localConfig(at), /username = octocat/);
  });

  test('use names push-as only where it pinned a credential, and says on which host it did not', () => {
    origin(SSH);
    const ssh = repown(['use', 'octocat'], at.box.dir);
    assert.equal(ssh.status, 0, ssh.stderr);
    assert.match(ssh.stdout, /OK\s+identity\s+Octo Cat <octocat@example\.invalid>\n/);
    assert.doesNotMatch(ssh.stdout, /push-as/);
    assert.match(ssh.stderr, /credentials on GitHub are not pinned by repown\./);
    at.box.git('remote', 'set-url', 'origin', 'https://git.example.invalid/octocat/project.git');
    assert.match(repown(['use', 'octocat'], at.box.dir).stderr, /credentials on this host are not pinned by repown\./);
  });

  test('off still removes the key use wrote when an insteadOf sends origin elsewhere since', () => {
    origin(HTTPS);
    assert.equal(repown(['use', 'octocat'], at.box.dir).status, 0);
    at.box.git('config', '--global', 'url.git@github.com:.insteadOf', 'https://github.com/');
    assert.equal(repown(['off'], at.box.dir).status, 0);
    assert.doesNotMatch(localConfig(at), /username = octocat/);
  });
});
