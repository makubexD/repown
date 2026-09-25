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
  /** The provider of origin's host (`generic` without an origin), and who owns origin. */
  readonly host: string;
  readonly owner: string | null;
  /** `repown.allowOwner` entries in this clone, lowercased. */
  readonly allowed: readonly string[];
  /** False where the host has no per-account credential pin (ADR-009). */
  readonly credentialPinned: boolean;
  /** Null when gh isn't installed; an error when it couldn't be queried. */
  readonly gh: Result<GhState> | null;
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
      detail: () => (ctx.pinned ? 'this clone is pinned to ' + ctx.pinned + ' now' : undefined) },
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
      message: 'Allow pushes to "' + (ctx.owner ?? '') + '" from this clone?',
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

function newAccountProblem(value: string, ctx: SetupContext): string | null {
  if (!value.trim()) return 'a value is required';
  const clash = Object.keys(ctx.recorded).find((account) => lower(account) === lower(value.trim()));
  return clash ? '"' + clash + '" is already recorded: pick it from the list instead' : null;
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
  return planned.filter((argv): argv is readonly string[] => argv !== null).map((argv) => ({ argv }));
}

function allowOwnerLine(ctx: SetupContext): string[] {
  return ['git', ...(ctx.cwd ? ['-C', ctx.cwd] : []), 'config', '--local', '--add', 'repown.allowOwner', ctx.owner!];
}

/**
 * The command as you would type it: the account where it reads naturally, options
 * as `--name value`, and `--host github` left out because it's the default.
 */
export function formatCommand(argv: readonly string[]): string {
  if (argv[0] === 'git') return argv.map(shellWord).join(' ');
  const end = argv.indexOf('--');
  const head = end < 0 ? argv : argv.slice(0, end);
  const positional = end < 0 ? [] : argv.slice(end + 1);
  const path = head.filter((token) => !token.startsWith('-'));
  const options = head.filter((token) => token.startsWith('-') && token !== '--host=github').flatMap(splitOption);
  const dashed = positional.some((value) => value.startsWith('-'));
  const words = dashed ? [...path, ...options, '--', ...positional] : [...path, ...positional, ...options];
  return ['repown', ...words.map(shellWord)].join(' ');
}

function splitOption(token: string): string[] {
  const at = token.indexOf('=');
  return at < 0 ? [token] : [token.slice(0, at), token.slice(at + 1)];
}

/** What `--no-input` still needs, as the flags that would supply it. */
export function missingFlags(given: Answers, recorded: Readonly<Record<string, unknown>>): string[] {
  if (given['account'] === undefined && given['newAccount'] === undefined) return ['<account>'];
  if (!isNew(given) || Object.hasOwn(recorded, accountOf(given))) return [];
  return (['name', 'email'] as const).filter((key) => given[key] === undefined).map((key) => '--' + key);
}

// ---------------------------------------------------------------- the review

function review(answers: Answers, ctx: SetupContext): Review {
  return { summary: summary(answers, ctx), commands: planCommands(answers, ctx).map((command) => formatCommand(command.argv)) };
}

function summary(answers: Answers, ctx: SetupContext): string[] {
  const account = accountOf(answers);
  const lines = [
    'account    ' + account + (isNew(answers) ? '  (new: ' + String(answers['name']) + ' <' + String(answers['email']) + '>)' : ''),
    ctx.credentialPinned ? 'pushes as  ' + account : 'pushes as  not pinned by repown on this host; its own sign-in decides',
    'guard      ' + guardSummary(answers, ctx),
  ];
  if (ctx.pinned && lower(ctx.pinned) !== lower(account)) lines.push('note       switches this clone from ' + ctx.pinned);
  if (answers['guard'] === true && ownerForeign(account, ctx) && answers['allowOwner'] !== true) {
    lines.push('warning    the guard will refuse pushes to "' + ctx.owner + '" until it is allowed');
  }
  if (answers['fix'] === true) lines.push(...(ctx.fixLines ?? []));
  return lines;
}

function guardSummary(answers: Answers, ctx: SetupContext): string {
  if (ctx.redirected) return 'left alone: core.hooksPath points hooks elsewhere';
  if (ctx.guard === 'foreign') return 'left alone: another tool owns the pre-push hook';
  if (ctx.guard === 'on') return 'already on';
  return answers['guard'] === true ? 'turned on' : 'stays off';
}
