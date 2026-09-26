// What `repown setup` asks, and what the answers turn into. Every answer becomes a
// flag or argument of a command that already exists -- `accounts add`, `use`,
// `guard on`, `fix` -- or the one git line ADR-004 documents for an organisation,
// so the review can show exactly what will run, and a script can run the same thing.
//
// Pure: no I/O. What the clone and the machine look like arrives as a SetupContext
// (src/wizard/setup-context.ts), read before the first question.

import { providers, type Profile } from '../core/hosts/index.ts';
import { shellWord } from '../core/guard/check.ts';
import type { Account } from '../core/registry.ts';
import type { GhState } from '../core/credential/gh.ts';
import type { GuardState } from '../core/guard/hook.ts';
import type { Result } from '../core/result.ts';
import type { Answers, Choice, Flow, Review, Step } from './engine.ts';

/** The "a new account" choice. Empty, so it can never be a real account's name. */
export const NEW_ACCOUNT = '';

export interface SetupContext {
  /** `--cwd` as given, passed on to every command that acts on the clone. */
  readonly cwd: string | null;
  readonly recorded: Readonly<Record<string, Account>>;
  /** `repown.account` in this clone, if it is pinned already. */
  readonly pinned: string | null;
  /** `use <pinned>` would write nothing new: every key it writes already holds, exactly. */
  readonly pinIntact: boolean;
  /** The provider of origin's host (`github`, only as a default, without an origin), and who owns origin. */
  readonly host: string;
  readonly owner: string | null;
  /** `repown.allowOwner` entries in this clone, lowercased. */
  readonly allowed: readonly string[];
  /** False where the host has no per-account credential pin (ADR-009). */
  readonly credentialPinned: boolean;
  /** Null when gh isn't installed; an error when it couldn't be queried. */
  readonly gh: Result<GhState> | null;
  /** gh is git's credential helper, so pushes sign in as gh's active account, not the pin. */
  readonly ghIsHelper: boolean;
  readonly guard: GuardState;
  readonly redirected: boolean;
  /** What `fix` would remove, when gh is the helper on a GitHub clone; otherwise null. */
  readonly fixLines: readonly string[] | null;
  /** Author and committer addresses in this clone's history. */
  readonly addresses: Result<ReadonlyMap<string, number>>;
  suggest(account: string, host: string): Promise<Profile>;
}

export interface PlannedCommand {
  /** For repown: the command path, options, `--`, positionals. For git: the git argv. */
  readonly argv: readonly string[];
  /** What it does, in plain words: the review's numbered step, and the run's progress line. */
  readonly what: string;
}

const lower = (value: string): string => value.toLowerCase();

/** The account the answers are about: a recorded one, or the new one typed in. */
export function accountOf(answers: Answers): string {
  const picked = answers['account'];
  return picked === undefined || picked === NEW_ACCOUNT ? String(answers['newAccount'] ?? '') : String(picked);
}

export function isNew(answers: Answers): boolean {
  return (answers['account'] ?? NEW_ACCOUNT) === NEW_ACCOUNT;
}

export function setupFlow(ctx: SetupContext): Flow<SetupContext> {
  return { steps: steps(ctx), review: (answers) => review(answers, ctx) };
}

function steps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    { id: 'account', kind: 'select', flag: '<account>', message: 'Which account owns this clone?',
      hint: 'its commits and pushes go out as this account',
      when: () => Object.keys(ctx.recorded).length > 0,
      choices: () => accountChoices(ctx), initial: () => defaultAccount(ctx),
      detail: () => (ctx.pinned ? 'currently pinned to ' + ctx.pinned : undefined) },
    { id: 'newAccount', kind: 'text', flag: '<account>', message: 'Account login',
      hint: 'your user name on the host, e.g. octocat', when: (answers) => isNew(answers),
      validate: (value) => newAccountProblem(String(value), ctx) },
    { id: 'host', kind: 'select', flag: '--host', message: 'Where is this account?',
      hint: 'decides how its sign-in is pinned', when: (answers) => isNew(answers),
      choices: () => providers().map((provider) => ({ value: provider.id, label: provider.label })),
      initial: () => ctx.host },
    { id: 'name', kind: 'text', flag: '--name', message: 'Commit name', hint: 'shown on every commit',
      when: (answers) => isNew(answers), validate: required,
      initial: async (answers) => (await ctx.suggest(accountOf(answers), hostOf(answers, ctx))).name ?? accountOf(answers) },
    { id: 'email', kind: 'text', flag: '--email', message: 'Commit email',
      hint: 'a noreply address keeps yours private', when: (answers) => isNew(answers), validate: required,
      initial: async (answers) => (await ctx.suggest(accountOf(answers), hostOf(answers, ctx))).email },
    ...choiceSteps(ctx),
  ];
}

function choiceSteps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    { id: 'gh', kind: 'confirm', flag: '--gh', message: 'Also switch the GitHub CLI to this account?',
      hint: 'for gh pr create and gh api; git does not need it', initial: () => false,
      when: (answers) => ghOffered(accountOf(answers), ctx) },
    { id: 'allowOwner', kind: 'confirm', flag: '--allow-owner', initial: () => true,
      message: 'Allow pushes to "' + printable(ctx.owner ?? '') + '" from this clone?',
      hint: 'an organisation you belong to; one repo-local key',
      when: (answers) => ownerForeign(accountOf(answers), ctx) },
    { id: 'guard', kind: 'confirm', flag: '--guard', message: 'Check every push before it leaves?',
      hint: 'undo any time: repown guard off', initial: () => true,
      when: () => ctx.guard === 'off' && !ctx.redirected, detail: (answers) => historyNote(answers, ctx) },
    { id: 'fix', kind: 'confirm', flag: '--fix', message: 'Stop gh being git\'s credential helper? (machine-wide)',
      hint: 'undo any time: gh auth setup-git', initial: () => false, when: () => ctx.fixLines !== null,
      detail: () => 'gh serves only its active account, so other clones get a password prompt' },
  ];
}

function accountChoices(ctx: SetupContext): Choice[] {
  const recorded = Object.entries(ctx.recorded).map(([account, entry]) =>
    ({ value: account, label: account, hint: entry.name + ' <' + entry.email + '>' }));
  return [...recorded, { value: NEW_ACCOUNT, label: 'a new account', hint: 'recorded once for this machine' }];
}

function defaultAccount(ctx: SetupContext): string {
  if (ctx.pinned && Object.hasOwn(ctx.recorded, ctx.pinned)) return ctx.pinned;
  return Object.keys(ctx.recorded)[0] ?? NEW_ACCOUNT;
}

function required(value: unknown): string | null {
  return String(value).trim() ? null : 'a value is required';
}

/** A login as hosts spell them: it also becomes part of a profile lookup's URL. */
const LOGIN = /^[\w.@-]+$/;

function newAccountProblem(value: string, ctx: SetupContext): string | null {
  if (!value.trim()) return 'a value is required';
  if (!LOGIN.test(value)) return 'use letters, digits and . _ @ - only';
  const clash = Object.keys(ctx.recorded).find((account) => lower(account) === lower(value));
  return clash ? '"' + clash + '" is already recorded: use that account by that name' : null;
}

function hostOf(answers: Answers, ctx: SetupContext): string {
  return typeof answers['host'] === 'string' ? answers['host'] : ctx.host;
}

function ghOffered(account: string, ctx: SetupContext): boolean {
  if (ctx.host !== 'github' || !ctx.gh?.ok) return false;
  const known = ctx.gh.value.accounts.some((entry) => lower(entry.login) === lower(account));
  return known && lower(ctx.gh.value.active ?? '') !== lower(account);
}

function ownerForeign(account: string, ctx: SetupContext): boolean {
  if (!ctx.owner || lower(ctx.owner) === lower(account)) return false;
  return !ctx.allowed.includes(lower(ctx.owner));
}

/** The addresses in history besides this account's, said as a count -- or that it couldn't be read. */
function historyNote(answers: Answers, ctx: SetupContext): string {
  if (!ctx.addresses.ok) return 'this clone\'s history could not be read (' + ctx.addresses.error + ')';
  const own = lower(emailOf(answers, ctx) ?? '');
  const others = [...ctx.addresses.value.keys()].filter((address) => lower(address) !== own).length;
  if (others === 0) return 'only your address is in this clone\'s history';
  return others + ' other address' + (others === 1 ? ' is' : 'es are') + ' in this history: fine if you push only ' +
    'your own commits; choose No if you push commits others made here';
}

function emailOf(answers: Answers, ctx: SetupContext): string | undefined {
  if (isNew(answers)) return typeof answers['email'] === 'string' ? answers['email'] : undefined;
  return ctx.recorded[accountOf(answers)]?.email;
}

// ------------------------------------------------------------------ the plan

/** The commands the answers stand for, in the order they run. */
export function planCommands(answers: Answers, ctx: SetupContext): PlannedCommand[] {
  const account = accountOf(answers);
  const cwd = ctx.cwd ? ['--cwd=' + ctx.cwd] : [];
  const planned: (readonly string[] | null)[] = [
    isNew(answers) ? ['accounts', 'add', '--name=' + String(answers['name']), '--email=' + String(answers['email']),
      '--host=' + hostOf(answers, ctx), '--', account] : null,
    answers['allowOwner'] === true && ctx.owner ? allowOwnerLine(ctx) : null,
    answers['fix'] === true ? ['fix', '--yes', ...cwd] : null,
    ['use', ...(answers['gh'] === true ? ['--gh'] : []), ...cwd, '--', account],
    answers['guard'] === true ? ['guard', 'on', ...cwd] : null,
  ];
  return planned.filter((argv): argv is readonly string[] => argv !== null).map((argv) => ({ argv, what: whatOf(argv, answers, ctx) }));
}

/** What a planned command does, in words for someone who has never used repown. */
function whatOf(argv: readonly string[], answers: Answers, ctx: SetupContext): string {
  const account = accountOf(answers);
  if (argv[0] === 'accounts') {
    return 'Record the account ' + account + ' (' + String(answers['name']) + ' <' + String(answers['email']) + '>) on this machine, for any clone';
  }
  if (argv[0] === 'git') return 'Allow pushes to ' + ctx.owner + '\'s repositories from this clone';
  if (argv[0] === 'fix') return 'Stop gh answering git\'s sign-in requests, on this whole machine (undo: gh auth setup-git)';
  if (argv[0] === 'guard') return 'Turn on the push guard: a pre-push hook checks every push before it leaves';
  const what = ctx.credentialPinned ? 'its name, email and push account' : 'its name and email';
  const gh = answers['gh'] === true ? '; and make ' + account + ' gh\'s active account' : '';
  return 'Pin this clone to ' + account + ': ' + what + ' go in .git/config, which is never pushed' + gh;
}

function allowOwnerLine(ctx: SetupContext): string[] {
  return ['git', ...(ctx.cwd ? ['-C', ctx.cwd] : []), 'config', '--local', '--add', 'repown.allowOwner', ctx.owner!];
}

/**
 * The command as you would type it: the account where it reads naturally, options
 * as `--name value`, and `--host github` left out because it's the default.
 */
export function formatCommand(argv: readonly string[]): string {
  if (argv[0] === 'git') return printable(argv.map(shellWord).join(' '));
  const end = argv.indexOf('--');
  const head = end < 0 ? argv : argv.slice(0, end);
  const positional = end < 0 ? [] : argv.slice(end + 1);
  const path = head.filter((token) => !token.startsWith('-'));
  const options = head.filter((token) => token.startsWith('-') && token !== '--host=github').flatMap(splitOption);
  const dashed = positional.some((value) => value.startsWith('-'));
  const words = dashed ? [...path, ...options, '--', ...positional] : [...path, ...positional, ...options];
  return printable(['repown', ...words.map(shellWord)].join(' '));
}

/** Control characters as visible escapes: a value read from a remote URL must not redraw the screen. */
export function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, (char) => '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** `--name=value` as `--name value`, unless the value starts with a dash and would read as an option. */
function splitOption(token: string): string[] {
  const at = token.indexOf('=');
  return at < 0 || token[at + 1] === '-' ? [token] : [token.slice(0, at), token.slice(at + 1)];
}

/** What `--no-input` still needs, as the flags that would supply it. */
export function missingFlags(given: Answers, recorded: Readonly<Record<string, unknown>>): string[] {
  if (given['account'] === undefined) return ['<account>'];
  if (!isNew(given)) return [];
  if (accountOf(given) && Object.hasOwn(recorded, accountOf(given))) return [];
  const login = accountOf(given) ? [] : ['<account>'];
  return [...login, ...(['name', 'email'] as const).filter((key) => given[key] === undefined).map((key) => '--' + key)];
}

// ---------------------------------------------------------------- the review

function review(answers: Answers, ctx: SetupContext): Review {
  const plan = planCommands(answers, ctx);
  const steps = plan.map((command) => ({
    what: printable(command.what), command: formatCommand(command.argv),
    detail: command.argv[0] === 'fix' ? (ctx.fixLines ?? []).map(printable) : [],
  }));
  if (settled(answers, ctx, plan)) {
    return { title: 'This clone is already set up', headline: settledLines(answers, ctx).map(printable), steps,
      notes: ['Checked: this clone is pinned to ' + printable(accountOf(answers)) + ', exactly as recorded.',
        'Check it any time: repown    this machine: repown doctor'], settled: true };
  }
  return { title: 'Review: nothing has changed yet', headline: [printable(headline(answers, ctx))], steps,
    notes: notes(answers, ctx).map(printable), settled: false };
}

/**
 * Nothing to do: the only command left is pinning this clone to the account it is
 * already pinned to, exactly as recorded, with nothing `use` would warn about -- an
 * organisation the guard would refuse, or gh answering sign-ins instead of the pin.
 */
function settled(answers: Answers, ctx: SetupContext, plan: readonly PlannedCommand[]): boolean {
  const account = accountOf(answers);
  const onlyPin = plan.length === 1 && plan[0]!.argv[0] === 'use' && !plan[0]!.argv.includes('--gh');
  return onlyPin && !isNew(answers) && account === ctx.pinned && ctx.pinIntact && !ctx.ghIsHelper && !ownerForeign(account, ctx);
}

function headline(answers: Answers, ctx: SetupContext): string {
  const account = accountOf(answers);
  if (ctx.credentialPinned) return 'This clone will commit and push as ' + account + '.';
  return 'This clone will commit as ' + account + '. Its pushes sign in with whatever you use for this host: ' +
    'repown pins the sign-in on GitHub only.';
}

function settledLines(answers: Answers, ctx: SetupContext): string[] {
  const account = accountOf(answers);
  const entry = ctx.recorded[account];
  return [
    'commits as  ' + (entry ? entry.name + ' <' + entry.email + '>' : account),
    'pushes as   ' + (ctx.credentialPinned ? account : 'your own sign-in for this host (repown pins it on GitHub only)'),
    'guard       ' + guardState(ctx),
  ];
}

function guardState(ctx: SetupContext): string {
  if (ctx.redirected) return 'not repown\'s: core.hooksPath sends hooks elsewhere';
  if (ctx.guard === 'foreign') return 'not repown\'s: another tool owns the pre-push hook';
  return ctx.guard === 'on' ? 'on: every push is checked before it leaves' : 'off: turn it on with repown guard on';
}

function notes(answers: Answers, ctx: SetupContext): string[] {
  const account = accountOf(answers);
  const lines: string[] = [];
  if (ctx.pinned && lower(ctx.pinned) !== lower(account)) {
    lines.push('This clone moves from ' + ctx.pinned + ' to ' + account + ': its next commits and pushes use ' + account +
      '. Commits already made keep their author.');
  }
  const guard = guardNote(answers, ctx);
  if (guard) lines.push(guard);
  const guarded = answers['guard'] === true || ctx.guard === 'on';
  if (guarded && ownerForeign(account, ctx) && answers['allowOwner'] !== true) {
    lines.push('Warning: the guard will refuse pushes to "' + ctx.owner + '" until it is allowed.');
  }
  if (ctx.ghIsHelper && answers['fix'] !== true && ctx.credentialPinned) {
    lines.push('Note: gh is still git\'s credential helper, so pushes sign in as gh\'s active account, not ' + account + '.');
  }
  return lines;
}

/** What happens to the guard, when no step says it already. */
function guardNote(answers: Answers, ctx: SetupContext): string | null {
  if (ctx.redirected) return 'The push guard stays off: core.hooksPath sends this clone\'s hooks elsewhere (see: repown guard status).';
  if (ctx.guard === 'foreign') {
    return 'The push guard stays off: another tool (husky, for example) owns this clone\'s pre-push hook. ' +
      'To keep the check, call repown guard check from that hook (HOW-IT-WORKS card 10).';
  }
  if (ctx.guard === 'on') return 'The push guard is already on in this clone.';
  return answers['guard'] === true ? null
    : 'The push guard stays off: pushes are not checked (turn it on later: repown guard on).';
}
