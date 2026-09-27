// Which logins `repown setup` can already see. Pure: no git, no gh, no network.
// The names are the only ones this repo allows.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from '../src/core/result.ts';
import { detectedAccounts, type DetectionInput } from '../src/wizard/setup-context.ts';

const OWNS = 'owns this repository';
const GH = 'signed in to gh';
const GCM = 'stored in Git Credential Manager';

function detect(over: Partial<DetectionInput> = {}) {
  return detectedAccounts({
    github: over.github ?? true,
    owner: over.owner ?? null,
    ownerIsUser: over.ownerIsUser ?? null,
    gh: over.gh ?? null,
    stored: over.stored ?? null,
    recorded: over.recorded ?? [],
  });
}

describe('accounts repown can already see', () => {
  test('the same login from the owner, gh and GCM, in different case, is one entry with every source in order', () => {
    assert.deepEqual(detect({
      owner: 'Octocat',
      ownerIsUser: true,
      gh: ok(['octocat']),
      stored: ok(['OCTOCAT']),
    }), [{ login: 'Octocat', from: [OWNS, GH, GCM] }]);
  });

  test('a recorded account is excluded, comparing without case', () => {
    assert.deepEqual(detect({
      owner: 'octocat',
      ownerIsUser: true,
      gh: ok(['OctoCat', 'octo-work']),
      stored: ok(['OCTOCAT']),
      recorded: ['Octocat'],
    }), [{ login: 'octo-work', from: [GH] }]);
  });

  test('an origin that is not GitHub detects nothing', () => {
    assert.deepEqual(detect({
      github: false,
      owner: 'octocat',
      ownerIsUser: true,
      gh: ok(['octo-work']),
      stored: ok(['octocat']),
    }), []);
  });

  test('an organisation that owns the repository is excluded from every source', () => {
    assert.deepEqual(detect({
      owner: 'octo-org',
      ownerIsUser: false,
      gh: ok(['Octo-Org', 'octo-work']),
      stored: ok(['octo-org']),
    }), [{ login: 'octo-work', from: [GH] }]);
  });

  test('distinct logins stay in the order they are first seen', () => {
    assert.deepEqual(detect({
      owner: 'octocat',
      ownerIsUser: true,
      gh: ok(['octo-work']),
      stored: ok(['octo-org', 'octo-work']),
    }), [
      { login: 'octocat', from: [OWNS] },
      { login: 'octo-work', from: [GH, GCM] },
      { login: 'octo-org', from: [GCM] },
    ]);
  });

  test('an owner whose kind is unknown is kept', () => {
    assert.deepEqual(detect({ owner: 'octocat', ownerIsUser: null }), [{ login: 'octocat', from: [OWNS] }]);
  });

  test('a failed gh or credential-manager lookup is ignored', () => {
    assert.deepEqual(detect({
      owner: 'octocat',
      ownerIsUser: true,
      gh: err('gh auth status failed'),
      stored: err('Git Credential Manager is not installed'),
    }), [{ login: 'octocat', from: [OWNS] }]);
  });
});
