// The guided repair in a plain terminal, for `repown doctor --online` (ADR-032): questions
// through `confirm`, the SSO wait through `waitForEnter`, and each repair through the
// command that owns it (`repown fix`, `repown use`) or GCM's own sign-in. Never a copy.

import type { Args } from '../ui/args.ts';
import { flagString } from '../ui/args.ts';
import { confirm, waitForEnter } from '../ui/prompt.ts';
import * as out from '../ui/format.ts';
import { printable } from '../ui/format.ts';
import { gcmGithubLogin } from '../core/credential/gcm.ts';
import type { Repair } from '../core/signin-repair.ts';
import type { GuideIo } from './signin-guide.ts';
import fixCommand from './fix.ts';
import useCommand from './use.ts';

export function terminalIo(args: Args): GuideIo {
  // The user asked for the check, so each repair defaults to Yes; Enter runs it.
  return { confirm: (question) => confirm(printable(question), true), waitEnter: waitForEnter, say: (line) => out.warn('sign-in', line), run: (repair) => runRepair(repair, args) };
}

/** Runs a repair as its own command would, in the same directory doctor was asked about. */
export async function runRepair(repair: Exclude<Repair, { kind: 'sso' }>, args: Args): Promise<boolean> {
  const cwd = flagString(args, 'cwd');
  const flags = (extra: [string, string | boolean][]): Map<string, string | boolean> => new Map([...(cwd ? [['cwd', cwd] as [string, string]] : []), ...extra]);
  // fix previews what it removes, and where, then asks its own question (default No).
  if (repair.kind === 'fix') return await fixCommand.run({ positional: [], flags: flags([]) }) === 0;
  if (repair.kind === 'use') return await useCommand.run({ positional: [repair.account], flags: flags([]) }) === 0;
  return gcmGithubLogin(repair.account);
}
