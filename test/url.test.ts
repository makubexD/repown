import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitUrl, credentialPrefix } from '../src/core/url.ts';
import { providerFor } from '../src/core/hosts/index.ts';

const owner = (raw: string): string | null => {
  const url = parseGitUrl(raw);
  return url ? providerFor(url).ownerOf(url) : null;
};
const providerId = (raw: string): string => providerFor(parseGitUrl(raw)).id;

describe('parseGitUrl', () => {
  test('https with a .git suffix', () => {
    const url = parseGitUrl('https://github.com/octocat/hello-world.git')!;
    assert.equal(url.host, 'github.com');
    assert.deepEqual(url.segments, ['octocat', 'hello-world']);
    assert.equal(url.user, null);
  });

  test('userinfo is kept SEPARATE from the host and never treated as the owner', () => {
    // The guard this replaces substring-matched the whole URL, so this exact
    // shape passed an ownership check while pushing to someone else's repo.
    const url = parseGitUrl('https://octocat@github.com/SomeoneElse/repo.git')!;
    assert.equal(url.user, 'octocat');
    assert.equal(url.segments[0], 'SomeoneElse');
    assert.equal(owner('https://octocat@github.com/SomeoneElse/repo.git'), 'SomeoneElse');
  });

  test('scp-like form', () => {
    const url = parseGitUrl('git@github.com:octocat/repo.git')!;
    assert.equal(url.scheme, 'ssh');
    assert.equal(url.host, 'github.com');
    assert.deepEqual(url.segments, ['octocat', 'repo']);
  });

  test('percent-encoded path segments are decoded', () => {
    const url = parseGitUrl('https://contoso.visualstudio.com/A%20B%20C/_git/repo')!;
    assert.equal(url.segments[0], 'A B C');
  });

  test('credentialPrefix is what git keys credential config on', () => {
    assert.equal(credentialPrefix(parseGitUrl('https://github.com/a/b')!), 'https://github.com');
  });

  test('rubbish is null, not a throw', () => {
    assert.equal(parseGitUrl(''), null);
    assert.equal(parseGitUrl('   '), null);
  });
});

describe('provider resolution', () => {
  test('github', () => {
    assert.equal(providerId('https://github.com/octocat/repo.git'), 'github');
    assert.equal(providerId('https://gist.github.com/octocat/abc'), 'github');
  });

  test('azure devops, BOTH url forms, disagreeing about the first path segment', () => {
    // Legacy: organisation is the SUBDOMAIN, first segment is the project.
    assert.equal(providerId('https://contoso.visualstudio.com/Proj/_git/repo'), 'azdo');
    assert.equal(owner('https://contoso.visualstudio.com/Proj/_git/repo'), 'contoso');

    // Modern: organisation IS the first segment.
    assert.equal(owner('https://dev.azure.com/contoso/Proj/_git/repo'), 'contoso');
  });

  test('the generic provider would get the legacy form wrong -- hence azdo exists', () => {
    const url = parseGitUrl('https://contoso.visualstudio.com/Proj/_git/repo')!;
    assert.equal(url.segments[0], 'Proj');          // what a naive owner check sees
    assert.equal(providerFor(url).ownerOf(url), 'contoso'); // what is actually true
  });

  test('an unknown host falls through to generic, which still pins commit identity', () => {
    const provider = providerFor(parseGitUrl('https://git.example.com/team/repo.git'));
    assert.equal(provider.id, 'generic');
    assert.equal(provider.ownerOf(parseGitUrl('https://git.example.com/team/repo.git')!), 'team');
  });

  test('hosts with no verified credential model pin NOTHING rather than something wrong', async () => {
    const azdo = providerFor(parseGitUrl('https://dev.azure.com/org/p/_git/r'));
    assert.deepEqual(azdo.credentialKeys(parseGitUrl('https://dev.azure.com/org/p/_git/r')!), []);
    const stored = await azdo.listStoredAccounts();
    assert.equal(stored.ok, false);   // "could not be asked", never "holds nothing"
  });

  test('github pins the key GCM actually reads', () => {
    const url = parseGitUrl('https://github.com/octocat/repo.git')!;
    assert.deepEqual(providerFor(url).credentialKeys(url),
                     ['credential.https://github.com.username']);
  });
});

describe('local paths are not URLs', () => {
  for (const path of [
    'C:/Users/me/remote.git',
    'C:\\Users\\me\\remote.git',
    '/srv/git/remote.git',
    './sibling',
    '..\\sibling\\repo.git',
    '../sibling/repo.git',
    '\\\\server\\share\\repo.git',
  ]) {
    test(path + ' does not parse as a remote with an owner', () => {
      assert.equal(parseGitUrl(path), null,
        'a local path parsed as a URL fabricates an owner the guard then compares against');
    });
  }

  test('a real host that merely looks short still parses', () => {
    assert.equal(parseGitUrl('git@localhost:repo.git')?.host, 'localhost');
  });
});
