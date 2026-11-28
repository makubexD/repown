// The guided repair after a failed sign-in check (ADR-032): offer the repair, run it on a yes,
// check again; an SSO approval waits for Enter instead. Terminal only: the callers decide that,
// and without one doctor --online prints its advice and stops.
//
// The loop can't run forever: every repair but the SSO wait is tried once, a no or a q stops
// it, and a repair that didn't run stops it without another check.

import { repairQuestion, triedOnce, SSO_WAIT, type Repair } from '../core/signin-repair.ts';
import type { SignInReport } from '../core/signin-check.ts';

export interface GuidedCheck {
  readonly level: SignInReport['level'];
  /** The remote asked, for the closing line. */
  readonly remote: string;
  /** What repown can run for this verdict; null when nothing (or on a pass). */
  readonly repair: Repair | null;
  /** A repair ran during the loop, so what was read before it may be out of date. */
  readonly repaired?: boolean;
}

/** How the caller asks, waits and runs; doctor and setup each draw it their own way. */
export interface GuideIo {
  confirm(question: string): Promise<boolean>;
  /** False when the user stops (q). */
  waitEnter(message: string): Promise<boolean>;
  /** A line of information: what the loop concluded, when no check says it. */
  say(line: string): void;
  /** True when the repair ran to the end (exit 0). */
  run(repair: Exclude<Repair, { kind: 'sso' }>): Promise<boolean>;
}

export async function guideSignIn(check: () => Promise<GuidedCheck>, io: GuideIo): Promise<GuidedCheck> {
  const tried = new Set<string>();
  let repaired = false;
  let result = await check();
  while (result.level === 'fail' && result.repair) {
    if (!offerable(result.repair, tried)) { io.say(UNHELPED); break; }
    if (!await attempt(result.repair, io)) break;
    repaired ||= result.repair.kind !== 'sso';
    result = await check();
  }
  return repaired ? { ...result, repaired } : result;
}

/** Said when the same repair comes back after it ran: it is not offered again. */
export const UNHELPED = 'that repair ran, and the remote still refuses the sign-in; repown won\'t offer it again. The advice above is what is left.';

/** Records the repair as tried; false when it already was. */
function offerable(repair: Repair, tried: Set<string>): boolean {
  const key = triedOnce(repair);
  if (key === null) return true;
  if (tried.has(key)) return false;
  tried.add(key);
  return true;
}

async function attempt(repair: Repair, io: GuideIo): Promise<boolean> {
  if (repair.kind === 'sso') return io.waitEnter(SSO_WAIT);
  const question = repairQuestion(repair);
  if (question !== null && !await io.confirm(question)) return false;
  return io.run(repair);
}
