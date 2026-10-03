// What the repown reauthor test files share. Moved out of reauthor.test.ts unchanged when
// it was split so node --test can run the parts in parallel.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { sandbox, type Sandbox } from './helpers.ts';
import { Git } from '../src/core/git.ts';
import { planReauthor, applyReauthor } from '../src/core/reauthor.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export const OURS = 'octocat@example.invalid';

export const THEIRS = 'old@example.invalid';

/** A real rebase whose --exec fails on the first commit, as a failing amend would. */
export class FailingRebase extends Git {
  override rebaseExec(base: string): ReturnType<Git['rebaseExec']> {
    return super.rebaseExec(base, 'false');
  }
}
