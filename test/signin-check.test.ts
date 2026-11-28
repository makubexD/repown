// What git's answer to a dry-run push means, and what to do about it (ADR-031). Every stderr
// here was measured: github.com with no sign-in, a bogus token, and a field report's SAML SSO
// refusal (organisation and request token replaced).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifySignIn, describeSignIn, type SignInVerdict } from '../src/core/signin-check.ts';
import type { ExecResult } from '../src/core/exec.ts';

const URL = 'https://github.com/octo-org/project.git';
const failed = (stderr: string): ExecResult => ({ code: 128, stdout: '', stderr });

const SSO = "remote: The 'octo-org' organization has enabled or enforced SAML SSO.\n" +
  'remote: To access this repository, visit https://github.com/enterprises/octo-org/sso?authorization_request=ABC123 and try your request again.\n' +
  `fatal: unable to access '${URL}/': The requested URL returned error: 403\n`;
const SSH_TAIL = (first: string): string => first + '\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';
const BOGUS = 'remote: Invalid username or token. Password authentication is not supported for Git operations.\n' +
  `fatal: Authentication failed for '${URL}/'\n`;

describe('classifySignIn', () => {
  const cases: [string, ExecResult, SignInVerdict][] = [
    ['a dry run that succeeds', { code: 0, stdout: 'To ' + URL + '\n*\tHEAD:refs/heads/repown-sign-in-check\t[new branch]\nDone\n', stderr: '' }, { kind: 'ok' }],
    ['SAML SSO, with the link git printed', failed(SSO), { kind: 'sso', link: 'https://github.com/enterprises/octo-org/sso?authorization_request=ABC123' }],
    ['SAML SSO without a link', failed("remote: The 'octo-org' organization has enabled or enforced SAML SSO.\nfatal: 403\n"), { kind: 'sso', link: null }],
    ['a rejected token', failed(BOGUS), { kind: 'rejected' }],
    ['authentication failed alone', failed(`fatal: Authentication failed for '${URL}/'\n`), { kind: 'rejected' }],
    ['signed in as someone who cannot push', failed('remote: Permission to octo-org/project.git denied to octo-work.\nfatal: unable to access: 403\n'), { kind: 'denied', as: 'octo-work' }],
    ['a repository the account cannot see', failed(`remote: Repository not found.\nfatal: repository '${URL}/' not found\n`), { kind: 'not-found' }],
    ['no sign-in stored (git)', failed('fatal: unable to get password from user\n'), { kind: 'no-sign-in' }],
    ['no sign-in stored (GCM, prompts off)', failed('fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for \'https://github.com\': terminal prompts disabled\n'), { kind: 'no-sign-in' }],
    ['a host that does not resolve', failed("fatal: unable to access 'https://nonexistent.example.invalid/x.git/': Could not resolve host: nonexistent.example.invalid\n"), { kind: 'unchecked', reason: "fatal: unable to access 'https://nonexistent.example.invalid/x.git/': Could not resolve host: nonexistent.example.invalid" }],
    ['a timeout', { code: 1, stdout: '', stderr: '', timedOut: true }, { kind: 'unchecked', reason: 'timed out' }],
    ['an SSH key the host refused (measured)', failed(SSH_TAIL('git@github.com: Permission denied (publickey).')), { kind: 'ssh-key' }],
    ['a host key not trusted yet (measured)', failed(SSH_TAIL('No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.')), { kind: 'host-key' }],
    ['a ref the remote rejects after the sign-in passed', { code: 1, stdout: 'To ' + URL + '\n!\tHEAD:refs/heads/repown-sign-in-check\t[rejected] (fetch first)\nDone\n', stderr: 'error: failed to push some refs\n' }, { kind: 'ok' }],
  ];
  for (const [name, result, verdict] of cases) {
    test(name, () => assert.deepEqual(classifySignIn(result), verdict));
  }

  test('a credential in a URL git echoes is masked in the reason', () => {
    const verdict = classifySignIn(failed("fatal: unable to access 'https://octocat:ghp_secret@example.invalid/x.git/': Could not resolve host\n"));
    assert.equal(verdict.kind, 'unchecked');
    assert.doesNotMatch(JSON.stringify(verdict), /ghp_secret/);
  });
});

describe('describeSignIn', () => {
  const gcm = { remote: 'origin', host: 'github.com', account: 'octo-work', fromUrl: false, pinned: 'octo-work', helper: 'manager', github: true };

  test('OK names the account and has no fix', () => {
    const said = describeSignIn({ kind: 'ok' }, gcm);
    assert.equal(said.level, 'pass');
    assert.match(said.message, /octo-work/);
    assert.deepEqual(said.fix, []);
  });

  test('SSO gives the link, then the re-check', () => {
    const said = describeSignIn({ kind: 'sso', link: 'https://github.com/enterprises/octo-org/sso?x=1' }, gcm);
    assert.equal(said.level, 'fail');
    assert.deepEqual(said.fix, ['authorise it:  https://github.com/enterprises/octo-org/sso?x=1', 'then:          repown doctor --online']);
  });

  test('a rejected sign-in, through GCM on github.com, prints the measured login command', () => {
    const said = describeSignIn({ kind: 'rejected' }, gcm);
    assert.equal(said.level, 'fail');
    assert.deepEqual(said.fix, ['sign in again:  git credential-manager github login --username octo-work --browser --force']);
  });

  test('elsewhere, or without GCM, no command is claimed (ADR-009), but there is still a next step', () => {
    assert.deepEqual(describeSignIn({ kind: 'rejected' }, { ...gcm, helper: 'store' }).fix, ['sign in again through the credential helper (store); a push in a terminal asks']);
    assert.deepEqual(describeSignIn({ kind: 'no-sign-in' }, { ...gcm, github: false }).fix, ['sign in again through Git Credential Manager; a push in a terminal asks']);
  });

  test('gh as the helper: the fix is repown fix, since gh signs in as its active account', () => {
    assert.deepEqual(describeSignIn({ kind: 'rejected' }, { ...gcm, helper: '!/usr/bin/gh auth git-credential' }).fix, ['gh signs in as its active account; undo it:  repown fix']);
  });

  test('no helper at all says so', () => {
    assert.deepEqual(describeSignIn({ kind: 'no-sign-in' }, { ...gcm, helper: null }).fix, ['no credential helper serves this URL; install Git Credential Manager, then: repown doctor --online']);
  });

  test('an SSH key the host refused, and how to see whose key it is', () => {
    const said = describeSignIn({ kind: 'ssh-key' }, { ...gcm, account: null });
    assert.equal(said.level, 'fail');
    assert.match(said.message, /^origin refused this machine's SSH key/);
    assert.deepEqual(said.fix, ['see which account the key signs in as:  ssh -T git@github.com']);
  });

  test('a host key ssh does not trust yet', () => {
    const said = describeSignIn({ kind: 'host-key' }, { ...gcm, account: null });
    assert.equal(said.level, 'fail');
    assert.deepEqual(said.fix, ['check and trust it once:  ssh -T git@github.com']);
  });

  test('an account name no shell quotes safely gets no command', () => {
    assert.deepEqual(describeSignIn({ kind: 'rejected' }, { ...gcm, account: 'octo"work' }).fix, ['sign in again through Git Credential Manager; a push in a terminal asks']);
  });

  test('denied names who is signed in, and how to pin the right account', () => {
    const said = describeSignIn({ kind: 'denied', as: 'octocat' }, gcm);
    assert.match(said.message, /octocat/);
    assert.deepEqual(said.fix, ['use the pinned account:  repown use octo-work']);
  });

  test('where git sends no username (SSH, a local path, an unpinned host), no account is named', () => {
    const said = describeSignIn({ kind: 'ok' }, { ...gcm, account: null });
    assert.equal(said.message, 'origin accepts a push from this clone (a dry run: nothing was sent)');
    assert.doesNotMatch(describeSignIn({ kind: 'rejected' }, { ...gcm, account: null }).message, /octo-work/);
  });

  test('a repository the account cannot see says what to check', () => {
    assert.deepEqual(describeSignIn({ kind: 'not-found' }, gcm).fix, ['check the account (repown status), or ask for access']);
  });

  test('denied as a username the push URL names: the fix is the URL, never repown use', () => {
    const said = describeSignIn({ kind: 'denied', as: 'octocat' }, { ...gcm, account: 'octocat', fromUrl: true });
    assert.deepEqual(said.fix, ['the push URL names octocat; remove it (repown status prints the command)']);
  });

  test('denied as the pinned account itself asks for write access, with no repown use', () => {
    const said = describeSignIn({ kind: 'denied', as: 'octo-work' }, gcm);
    assert.match(said.message, /octo-work can't push here\./);
    assert.deepEqual(said.fix, ['ask the owner for write access']);
  });

  test('a check that could not run is a warning, never a pass', () => {
    const said = describeSignIn({ kind: 'unchecked', reason: 'timed out' }, gcm);
    assert.equal(said.level, 'warn');
    assert.match(said.message, /timed out/);
  });
});

describe('describeSignIn names the remote it asked', () => {
  test('a push remote other than origin is named in the verdict', () => {
    const ctx = { remote: 'upstream', host: null, account: null, fromUrl: false, pinned: null, helper: null, github: false };
    assert.match(describeSignIn({ kind: 'ok' }, ctx).message, /^upstream accepts a push/);
    assert.match(describeSignIn({ kind: 'not-found' }, ctx).message, /^upstream was not found/);
  });
});
