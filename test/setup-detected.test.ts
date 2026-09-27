// Which logins `repown setup` can already see. Pure: no git, no gh, no network.
// The names are the only ones this repo allows.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthState, RepoState } from '../src/core/inspect.ts';
import { ok, err } from '../src/core/result.ts';
import { askOwnerIsUser, detectedAccounts, type DetectionInput } from '../src/wizard/setup-context.ts';
import { DETECTED_PREFIX, setupFlow, SOURCE_GCM, SOURCE_GH, SOURCE_OWNS, type SetupContext } from '../src/wizard/setup-flow.ts';
import { setupContext } from './setup-fixtures.ts';

const OWNS = SOURCE_OWNS;
const GH = SOURCE_GH;
const GCM = SOURCE_GCM;

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

  test('D4 and D5 the account step uses detection\'s sources, and a recorded login is one row with no +', () => {
    const detected = detect({ owner: 'Octocat', ownerIsUser: null, gh: ok(['octocat']), stored: ok(['OCTOCAT']) });
    const fresh = setupContext({ recorded: {}, owner: 'Octocat', ownerIsUser: null, detected });
    const hint = [OWNS + '; may be an organisation', GH, GCM].join('; ');
    assert.equal(accountChoices(fresh)[0]?.hint, hint);

    const again = detect({
      owner: 'octocat', ownerIsUser: true, gh: ok(['OctoCat', 'octo-work']), stored: ok(['OCTOCAT']), recorded: ['Octocat'],
    });
    const recorded = setupContext({
      recorded: { Octocat: { name: 'Octo Cat', email: 'octocat@example.invalid', host: 'github' } },
      owner: 'octocat', ownerIsUser: true, detected: again,
    });
    const rows = accountChoices(recorded);
    const owners = rows.filter((choice) => /octocat/i.test(choice.label) || /octocat/i.test(String(choice.value)));
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.value, 'Octocat');
    assert.equal(rows.some((choice) => String(choice.value) === DETECTED_PREFIX + 'octocat'), false);
    assert.ok(rows.some((choice) => choice.value === DETECTED_PREFIX + 'octo-work'));
  });
});

describe('whether origin\'s owner is a user', () => {
  test('an owner signed in to gh is a user, and the kind lookup is not called', async () => {
    let calls = 0;
    const kind = await askOwnerIsUser(repo('octocat', async () => { calls += 1; return 'organization'; }), ghAuth(['OctoCat']));
    assert.equal(kind, true);
    assert.equal(calls, 0);
  });

  test('an owner gh does not list is still classified, recorded or not', async () => {
    let calls = 0;
    const kind = await askOwnerIsUser(repo('octo-org', async () => { calls += 1; return 'organization'; }), ghAuth(['octocat']));
    assert.equal(kind, false);
    assert.equal(calls, 1);
  });

  test('a gh query that failed does not count as a signed-in user', async () => {
    let calls = 0;
    const kind = await askOwnerIsUser(repo('octocat', async () => { calls += 1; return 'user'; }), authState(err('gh auth status failed')));
    assert.equal(kind, true);
    assert.equal(calls, 1);
  });

  test('setup that will not prompt does not classify', async () => {
    let calls = 0;
    const kind = await askOwnerIsUser(
      repo('octocat', async () => { calls += 1; return 'user'; }), ghAuth(['octocat']), { classifyOwner: false },
    );
    assert.equal(kind, null);
    assert.equal(calls, 0);
  });
});

function accountChoices(ctx: SetupContext) {
  const step = setupFlow(ctx).steps.find((item) => item.id === 'account');
  assert.ok(step?.choices);
  return step.choices({}, ctx);
}

function repo(owner: string, accountKind: (login: string) => Promise<'user' | 'organization' | null>): RepoState {
  return { owner, provider: { id: 'github', accountKind } } as RepoState;
}

function ghAuth(logins: readonly string[]): AuthState {
  const accounts = logins.map((login) => ({ login, active: login === logins[0] }));
  return authState(ok({ accounts, active: logins[0] ?? null }));
}

function authState(gh: AuthState['gh']): AuthState {
  return {
    gcmPath: null, gcmPresent: false, stored: ok([]), gh, ghPresent: true,
    helper: null, ghIsHelper: false, helperIsGcm: false, ghHelperOrigins: [],
  };
}
