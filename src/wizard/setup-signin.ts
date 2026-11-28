// Setup's last step (ADR-032): once the clone is set up with nothing in the way of the next
// push, ask whether to check the sign-in with the remote, and run doctor --online's check and
// guided repair if so. Terminal only, never under --no-input. The answer joins setup's closing
// line, so setup says "done" with the sign-in checked, or says what is left.

import type { Git } from '../core/git.ts';
import { inspectRepo } from '../core/inspect.ts';
import { gitFor, type Args } from '../ui/args.ts';
import { confirm } from '../ui/prompt.ts';
import { printable } from '../ui/format.ts';
import { checkOnline } from '../commands/doctor-online.ts';
import { guideSignIn, type GuidedCheck } from '../commands/signin-guide.ts';
import { terminalIo } from '../commands/signin-terminal.ts';

/** The step's two moves, so tests can play them without a terminal. */
export interface SignInStep {
  offer(): Promise<boolean>;
  check(): Promise<GuidedCheck>;
}

export type SignInOutcome =
  | { readonly kind: 'declined' }
  | { readonly kind: 'skipped'; readonly why: string }
  | { readonly kind: 'checked'; readonly check: GuidedCheck };

/** Why there is no push to try yet: the closing line says it, so a skip never reads as a pass. */
export const NO_COMMIT = 'no commit to try a push with yet';
export const NO_REMOTE = 'no remote to ask yet';

export const SIGNIN_QUESTION = 'Check the sign-in with the remote now? (one dry-run push: nothing is sent)';

export function terminalSignIn(args: Args): SignInStep {
  return {
    offer: () => confirm(SIGNIN_QUESTION, true),
    check: () => {
      let first = true;
      const once = async (): Promise<GuidedCheck> => {
        const repo = await inspectRepo(gitFor(args));
        const pinned = repo.identity.owner ?? repo.identity.account;
        const result = await checkOnline(repo, pinned, first);
        first = false;
        return result;
      };
      return guideSignIn(once, terminalIo(args));
    },
  };
}

/** Skipped, with the reason, when there is nothing to ask with: no commit, or no remote. */
export async function signInAfterSetup(step: SignInStep, git: Git): Promise<SignInOutcome> {
  if (await git.revParse('HEAD') === null) return { kind: 'skipped', why: NO_COMMIT };
  const remotes = await git.readRemotes();
  if (!remotes.ok || remotes.value.length === 0) return { kind: 'skipped', why: NO_REMOTE };
  if (!await step.offer()) return { kind: 'declined' };
  return { kind: 'checked', check: await step.check() };
}

/** What the closing line adds; a refusal is said instead of "done" (closingWords). */
export function signInSuffix(outcome: SignInOutcome | null): string {
  if (!outcome) return '';
  if (outcome.kind === 'skipped') return ' · sign-in not checked online (' + outcome.why + ')';
  if (outcome.kind === 'declined' || outcome.check.level === 'warn') return ' · sign-in not checked online';
  return outcome.check.level === 'pass' ? ' · ' + printable(outcome.check.remote) + ' accepts the sign-in' : '';
}

export function signInRefused(outcome: SignInOutcome | null): string | null {
  return outcome?.kind === 'checked' && outcome.check.level === 'fail' ? printable(outcome.check.remote) + ' refused the sign-in (above)' : null;
}
