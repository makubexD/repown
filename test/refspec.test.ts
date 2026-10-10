// Which tracking ref a remote's fetch refspecs give a branch, read the way git reads them
// (`remote.<name>.fetch`, including `^` negative refspecs), and where they write.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { trackingRefOf, trackingPrefixes } from '../src/core/refspec.ts';

describe('trackingRefOf', () => {
  test('the default glob maps every branch, nested ones too', () => {
    const specs = ['+refs/heads/*:refs/remotes/origin/*'];
    assert.equal(trackingRefOf(specs, 'refs/heads/main'), 'refs/remotes/origin/main');
    assert.equal(trackingRefOf(specs, 'refs/heads/x/y'), 'refs/remotes/origin/x/y');
  });

  test('a single-branch refspec maps only that branch', () => {
    const specs = ['+refs/heads/main:refs/remotes/origin/main'];
    assert.equal(trackingRefOf(specs, 'refs/heads/main'), 'refs/remotes/origin/main');
    assert.equal(trackingRefOf(specs, 'refs/heads/feature'), null);
  });

  test('a negative refspec leaves a branch out, whatever else maps it', () => {
    const specs = ['+refs/heads/*:refs/remotes/origin/*', '^refs/heads/feature'];
    assert.equal(trackingRefOf(specs, 'refs/heads/feature'), null);
    assert.equal(trackingRefOf(specs, 'refs/heads/main'), 'refs/remotes/origin/main');
  });

  test('a glob in the middle of the pattern, and a refspec with no destination', () => {
    assert.equal(trackingRefOf(['refs/heads/team-*-wip:refs/remotes/o/*'], 'refs/heads/team-a-wip'), 'refs/remotes/o/a');
    assert.equal(trackingRefOf(['refs/heads/main'], 'refs/heads/main'), null);
    assert.equal(trackingRefOf([], 'refs/heads/main'), null);
  });

  test('a short source name is a branch', () => {
    assert.equal(trackingRefOf(['main:refs/remotes/origin/main'], 'refs/heads/main'), 'refs/remotes/origin/main');
  });
});

describe('trackingPrefixes', () => {
  test('a glob destination is the namespace before its star; an exact one is the ref itself', () => {
    const specs = ['+refs/heads/*:refs/remotes/origin/*', 'main:refs/remotes/pin/main', '^refs/heads/x', 'refs/heads/y'];
    assert.deepEqual(trackingPrefixes(specs), ['refs/remotes/origin/', 'refs/remotes/pin/main']);
  });
});

describe('a destination outside refs/remotes/', () => {
  // `HEAD --not --remotes` counts only refs/remotes/*, so tracking refs elsewhere prove nothing (ADR-025).
  test('maps nothing and lives nowhere: refs/upstream/*, and a mirror refspec onto refs/*', () => {
    assert.equal(trackingRefOf(['+refs/heads/*:refs/upstream/origin/*'], 'refs/heads/main'), null);
    assert.deepEqual(trackingPrefixes(['+refs/heads/*:refs/upstream/origin/*']), []);
    assert.equal(trackingRefOf(['+refs/*:refs/*'], 'refs/heads/main'), null);
    assert.deepEqual(trackingPrefixes(['+refs/*:refs/*']), []);
    assert.deepEqual(trackingPrefixes(['+refs/heads/*:refs/remotes/mirror/*']), ['refs/remotes/mirror/']);
  });
});
