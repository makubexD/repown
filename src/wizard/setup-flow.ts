// What `repown setup` asks, and what the answers turn into. Every answer becomes a
// flag or argument of a command that already exists -- `accounts add`, `use`,
// `guard on`, `fix` -- or a repo-local git line (an organisation's allowOwner, or
// push.autoSetupRemote), so the review can show exactly what will run, and a
// script can run the same thing.
//
// Pure: no I/O. What the clone and the machine look like arrives as a SetupContext
// (src/wizard/setup-context.ts), read before the first question.

import { ghAdvice } from '../commands/status.ts';
import { providers, type Profile } from '../core/hosts/index.ts';
import { shellWord } from '../core/guard/check.ts';
import { unpushedLines, type UnpushedFact } from '../core/unpushed.ts';
import type { Account } from '../core/registry.ts';
import type { GhState } from '../core/credential/gh.ts';
import type { GuardState } from '../core/guard/hook.ts';
import type { Result } from '../core/result.ts';
import { pinWrites, type IdentityValues } from '../core/identity.ts';
import { stepDefault } from './review-text.ts';
import type { Answers, Choice, Flow, Review, Step, StepConfirm } from './engine.ts';

/** The "a new account" choice. Empty, so it can never be a real account's name. */
export const NEW_ACCOUNT = '';

/** A detected choice's value. The login grammar refuses '+', so a recorded account cannot collide. */
export const DETECTED_PREFIX = '+';

/** A GitHub login repown can already see, and every place it was seen. */
export interface DetectedAccount {
  readonly login: string;
  readonly from: readonly string[];
}

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
  /** GitHub logins not already recorded. Empty when origin is not GitHub. */
  readonly detected: readonly DetectedAccount[];
  /** True for a user, false for an organisation, null when unknown. Null is not a user. */
  readonly ownerIsUser: boolean | null;
  /** `repown.allowOwner` entries in this clone, lowercased. */
  readonly allowed: readonly string[];
  /** False where the host has no per-account credential pin (ADR-009). */
  readonly credentialPinned: boolean;
  /** The credential keys `use` writes here. Empty where the host cannot be pinned. */
  readonly credentialKeys: readonly string[];
  /** The pre-push hook git will run, when this clone's hook path is known. */
  readonly hookPath: string | null;
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
  /** Commits on the current branch that no remote has. Compared here with the planned email. */
  readonly unpushed: UnpushedFact;
  /** Global `user.name` and `user.email`. Shown, never assumed to be this account. */
  readonly machineIdentity: { readonly name: string | null; readonly email: string | null };
  /** Git's `push.autoSetupRemote`: whether this git has it, the effective value, the branch. */
  readonly upstream: UpstreamRead;
  suggest(account: string, host: string): Promise<Profile>;
}

/** Read once, before the first question. `supported` is false when the version cannot be read. */
export interface UpstreamRead {
  readonly supported: boolean;
  /** Effective `push.autoSetupRemote`, or null when unset. */
  readonly enabled: boolean | null;
  /** The current branch, when HEAD names one. */
  readonly branch: string | null;
}

export interface PlannedCommand {
  /** For repown: the command path, options, `--`, positionals. For git: the git argv. */
  readonly argv: readonly string[];
  /** What it does, in plain words: the review's numbered step, and the run's progress line. */
  readonly what: string;
}

const lower = (value: string): string => value.toLowerCase();

/** The account the answers are about: a recorded one, a detected login, or the new one typed in. */
export function accountOf(answers: Answers): string {
  const picked = answers['account'];
  if (picked === undefined || picked === NEW_ACCOUNT) return String(answers['newAccount'] ?? '');
  return stripDetected(String(picked));
}

/** A recorded account is not new. A detected login still has to be recorded. */
export function isNew(answers: Answers): boolean {
  const picked = answers['account'];
  if (picked === undefined || picked === NEW_ACCOUNT) return true;
  return String(picked).startsWith(DETECTED_PREFIX);
}

function stripDetected(value: string): string {
  return value.startsWith(DETECTED_PREFIX) ? value.slice(DETECTED_PREFIX.length) : value;
}

/** The login is typed only for "a new account". A detected login is already chosen. */
function asksForLogin(answers: Answers): boolean {
  return (answers['account'] ?? NEW_ACCOUNT) === NEW_ACCOUNT;
}

export function setupFlow(ctx: SetupContext): Flow<SetupContext> {
  return { steps: steps(ctx), review: (answers) => review(answers, ctx), fill: (answers) => recommendedAnswers(answers, ctx) };
}

/** Yes for confirms Recommended skips. An answer already given, including from Change an answer, stays. */
export function recommendedAnswers(answers: Answers, ctx: SetupContext): Answers {
  if (!isRecommended(answers)) return answers;
  const filled = { ...answers };
  for (const step of steps(ctx)) fillRecommended(step, filled, ctx);
  return filled;
}

function fillRecommended(step: Step<SetupContext>, filled: Answers, ctx: SetupContext): void {
  if (filled[step.id] !== undefined || !step.auto?.(filled, ctx)) return;
  if (step.when && !step.when(filled, ctx)) return;
  filled[step.id] = true;
}

function isRecommended(answers: Answers): boolean {
  return answers['mode'] === 'recommended';
}

function steps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    modeStep(),
    ...accountSteps(ctx),
    { id: 'host', kind: 'select', flag: '--host', message: 'Where is this account hosted?',
      hint: 'on GitHub, repown also makes pushes sign in as this account', when: (answers) => isNew(answers),
      choices: () => hostChoices(), initial: () => ctx.host },
    { id: 'name', kind: 'text', flag: '--name', message: 'Your name, as your commits show it',
      hint: 'e.g. Octo Cat; anyone who can see the repository sees it', when: (answers) => isNew(answers), validate: required,
      initial: async (answers) => (await ctx.suggest(accountOf(answers), hostOf(answers, ctx))).name ?? accountOf(answers),
      detail: (answers) => nameDetail(answers, ctx) },
    { id: 'email', kind: 'text', flag: '--email', message: 'Your email, as your commits show it',
      hint: 'anyone who can see the repository can read it once you push', when: (answers) => isNew(answers), validate: required,
      initial: async (answers) => (await ctx.suggest(accountOf(answers), hostOf(answers, ctx))).email,
      detail: (answers) => emailDetail(answers, ctx) },
    ...choiceSteps(ctx),
  ];
}

function modeStep(): Step<SetupContext> {
  return {
    id: 'mode', kind: 'select', flag: '--step-by-step',
    message: 'How should setup work?',
    hint: 'Recommended fills in the answers that only change this clone; Step by step asks each one',
    choices: () => modeChoices(), initial: () => 'recommended',
  };
}

function modeChoices(): Choice[] {
  return [
    { value: 'recommended', label: 'Recommended',
      hint: 'asks only what it must, fills in the rest, and shows every step before running' },
    { value: 'step', label: 'Step by step',
      hint: 'asks every question, and explains each change before making it' },
  ];
}

function accountSteps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    { id: 'account', kind: 'select', flag: '<account>', message: 'Which account should this clone belong to?',
      hint: 'commits made here carry its name and email; on GitHub, pushes from here also sign in as it',
      when: () => Object.keys(ctx.recorded).length > 0 || ctx.detected.length > 0,
      choices: () => accountChoices(ctx), initial: () => defaultAccount(ctx),
      detail: () => (ctx.pinned ? 'right now this clone is pinned to ' + ctx.pinned : 'right now this clone isn\'t pinned to any account') },
    { id: 'newAccount', kind: 'text', flag: '<account>', message: 'The account\'s user name (login)',
      hint: 'the name you sign in with, e.g. octocat; not your email address', when: (answers) => asksForLogin(answers),
      validate: (value) => newAccountProblem(String(value), ctx), initial: () => ownerInitial(ctx) },
  ];
}

function choiceSteps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    ghStep(ctx),
    { id: 'allowOwner', kind: 'confirm', flag: '--allow-owner', initial: () => true,
      message: 'This repository belongs to "' + printable(ctx.owner ?? '') + '". Let this clone push to it?',
      hint: 'Yes if you\'re a member of that organisation or a collaborator on it; with No, ' +
        'the push guard refuses pushes there. Saved in this clone only',
      when: (answers) => ownerForeign(accountOf(answers), ctx) },
    { id: 'guard', kind: 'confirm', flag: '--guard', message: 'Turn on the push guard?',
      hint: 'before each push, it checks that every commit is yours and goes to the right place, and stops the push if not; ' +
        'turn it off any time: repown guard off',
      initial: () => true, when: () => ctx.guard === 'off' && !ctx.redirected, auto: isRecommended,
      detail: (answers) => historyNote(answers, ctx) },
    upstreamStep(ctx),
    { id: 'fix', kind: 'confirm', flag: '--fix', message: 'Stop gh answering git\'s sign-in requests? (whole machine)',
      hint: 'undo any time: gh auth setup-git', initial: () => false, when: () => ctx.fixLines !== null,
      detail: () => 'gh answers git\'s sign-in requests with its active account only, so clones of your other accounts ' +
        'get password prompts. Yes hands that job back to Git Credential Manager, for every repository on this machine' },
  ];
}

/** Labels for a newcomer; the providers' own labels stay as `repown` prints them elsewhere. */
const HOSTS: Readonly<Record<string, readonly [string, string]>> = {
  github: ['GitHub', 'name, email and the sign-in for pushes'],
  azdo: ['Azure DevOps', 'name and email; you sign in as usual'],
  generic: ['another host (GitLab, Bitbucket, self-hosted)', 'name and email; you sign in as usual'],
};

function hostChoices(): Choice[] {
  return providers().map((provider) => {
    const [label, hint] = HOSTS[provider.id] ?? [provider.label, ''];
    return { value: provider.id, label, ...(hint ? { hint } : {}) };
  });
}

/** Where a GitHub account's private address comes from, for someone who has never looked. */
function noreplyExample(answers: Answers, ctx: SetupContext): string | undefined {
  if (hostOf(answers, ctx) !== 'github') return undefined;
  return 'tip: to keep your own address private, use the one GitHub gives you, shown at ' +
    'github.com/settings/emails, like 1234+' + printable(accountOf(answers)) + '@users.noreply.github.com';
}

/** The machine's name, beside a new account. Never that account's initial value. */
function nameDetail(answers: Answers, ctx: SetupContext): string | undefined {
  const name = ctx.machineIdentity.name;
  if (!isNew(answers) || !name) return undefined;
  return 'not this machine\'s default name (' + printable(name) + '), unless this account uses it';
}

/** Noreply tip first, then the machine address. Two sentences; both prompters wrap one detail. */
function emailDetail(answers: Answers, ctx: SetupContext): string | undefined {
  const tip = noreplyExample(answers, ctx);
  const line = addressDetail(answers, ctx);
  if (tip && line) return tip + '; ' + line;
  return tip ?? line;
}

function addressDetail(answers: Answers, ctx: SetupContext): string | undefined {
  const email = ctx.machineIdentity.email;
  if (!isNew(answers) || !email) return undefined;
  return 'not this machine\'s default address (' + printable(email) + '), unless this account uses it';
}

const UPSTREAM_HINT = 'sets push.autoSetupRemote in this clone only, so the first push of a branch without an upstream ' +
  'creates it on origin; the guard still checks it';

/** Asked only when git has the key and the effective value is not already true. */
function offersUpstream(ctx: SetupContext): boolean {
  return ctx.upstream.supported && ctx.upstream.enabled !== true;
}

function upstreamStep(ctx: SetupContext): Step<SetupContext> {
  return {
    id: 'upstream', kind: 'confirm', flag: '--auto-upstream', initial: () => true,
    message: 'Push branches without -u?', hint: UPSTREAM_HINT,
    when: () => offersUpstream(ctx), auto: isRecommended,
  };
}

const SWITCH_MESSAGE = 'Also make this account gh\'s active account?';
const SWITCH_HINT = 'gh is GitHub\'s command-line tool: this changes the account gh commands use, in every terminal; git is not affected';

function ghStep(ctx: SetupContext): Step<SetupContext> {
  return {
    id: 'gh', kind: 'confirm', flag: '--gh', initial: () => false,
    message: (answers) => ghMessage(accountOf(answers), ctx),
    hint: (answers) => ghHint(accountOf(answers), ctx),
    detail: () => ghDetail(ctx),
    when: (answers) => ghAsked(accountOf(answers), ctx),
    auto: (answers) => isRecommended(answers) && inGh(accountOf(answers), ctx),
  };
}

function ghMessage(account: string, ctx: SetupContext): string {
  if (inGh(account, ctx)) return SWITCH_MESSAGE;
  return 'Sign in to gh as ' + printable(account) + ' too?';
}

function ghHint(account: string, ctx: SetupContext): string {
  if (inGh(account, ctx)) return SWITCH_HINT;
  return 'gh is GitHub\'s command-line tool (gh pr create); git pushes don\'t need it. ' +
    'Yes opens your browser to sign in, and gh then acts as ' + printable(account) + ' in every terminal';
}

function ghDetail(ctx: SetupContext): string {
  if (noGhAccounts(ctx)) return 'gh isn\'t signed in to any account';
  return 'gh\'s active account is ' + ghActive(ctx);
}

function noGhAccounts(ctx: SetupContext): boolean {
  return ctx.gh?.ok === true && ctx.gh.value.accounts.length === 0;
}

function ghAsked(account: string, ctx: SetupContext): boolean {
  if (ctx.host !== 'github' || !ctx.gh?.ok) return false;
  if (!inGh(account, ctx)) return true;
  return lower(ctx.gh.value.active ?? '') !== lower(account);
}

function inGh(account: string, ctx: SetupContext): boolean {
  if (!ctx.gh?.ok) return false;
  return ctx.gh.value.accounts.some((entry) => lower(entry.login) === lower(account));
}

function ghActive(ctx: SetupContext): string {
  return ctx.gh?.ok ? printable(ctx.gh.value.active ?? 'none') : 'unknown';
}

/** Where a detected login was seen. Detection records these; the account hint prints them. */
export const SOURCE_OWNS = 'owns this repository';
export const SOURCE_GH = 'signed in to gh';
export const SOURCE_GCM = 'stored in Git Credential Manager';

const OWNER_UNKNOWN = SOURCE_OWNS + '; may be an organisation';

function accountChoices(ctx: SetupContext): Choice[] {
  const recorded = Object.entries(ctx.recorded).map(([account, entry]) =>
    ({ value: account, label: account, hint: entry.name + ' <' + entry.email + '>' }));
  const detected = ctx.detected.map((account) => detectedChoice(account, ctx));
  return [...recorded, ...detected, { value: NEW_ACCOUNT, label: 'a new account', hint: 'record another account on this machine' }];
}

function detectedChoice(account: DetectedAccount, ctx: SetupContext): Choice {
  return {
    value: DETECTED_PREFIX + account.login,
    label: printable(account.login),
    hint: printable(detectedHint(account, ctx)),
  };
}

function detectedHint(account: DetectedAccount, ctx: SetupContext): string {
  return account.from.map((source) => sourceText(source, account, ctx)).join('; ');
}

function sourceText(source: string, account: DetectedAccount, ctx: SetupContext): string {
  if (source !== SOURCE_OWNS || ctx.ownerIsUser !== null) return source;
  return sameLogin(account.login, ctx.owner) ? OWNER_UNKNOWN : source;
}

function defaultAccount(ctx: SetupContext): string {
  return pinnedAccount(ctx) ?? recordedOwner(ctx) ?? detectedOwnerValue(ctx) ?? firstRecorded(ctx) ?? NEW_ACCOUNT;
}

/** Registry spelling of the pin. Case differs after a login is recorded again; the pin still wins. */
function pinnedAccount(ctx: SetupContext): string | undefined {
  return registrySpelling(ctx.recorded, ctx.pinned);
}

/** Registry spelling of the owner. A known organisation is listed with the recorded accounts and is not the default. */
function recordedOwner(ctx: SetupContext): string | undefined {
  if (ctx.ownerIsUser === false) return undefined;
  return registrySpelling(ctx.recorded, ctx.owner);
}

function registrySpelling(recorded: Readonly<Record<string, unknown>>, login: string | null): string | undefined {
  if (login === null) return undefined;
  return Object.keys(recorded).find((account) => sameLogin(account, login));
}

/** The first recorded account, other than an owner known to be an organisation. */
function firstRecorded(ctx: SetupContext): string | undefined {
  return Object.keys(ctx.recorded).find((account) => !knownOrganisation(ctx, account));
}

function knownOrganisation(ctx: SetupContext, account: string): boolean {
  return ctx.ownerIsUser === false && sameLogin(account, ctx.owner);
}

/** The detected spelling, which is the choice the list can highlight. */
function detectedOwnerValue(ctx: SetupContext): string | undefined {
  if (ctx.ownerIsUser !== true) return undefined;
  const found = ctx.detected.find((account) => sameLogin(account.login, ctx.owner));
  return found === undefined ? undefined : DETECTED_PREFIX + found.login;
}

/** Origin's owner, only as a typed login, and only when it is a user not recorded yet. */
function ownerInitial(ctx: SetupContext): string | undefined {
  const owner = ctx.owner;
  if (ctx.ownerIsUser !== true || owner === null) return undefined;
  const recorded = Object.keys(ctx.recorded).some((account) => sameLogin(account, owner));
  return recorded ? undefined : owner;
}

function sameLogin(login: string, other: string | null): boolean {
  return other !== null && lower(other) === lower(login);
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
  return clash ? '"' + clash + '" is already recorded on this machine: use it by that name' : null;
}

function hostOf(answers: Answers, ctx: SetupContext): string {
  return typeof answers['host'] === 'string' ? answers['host'] : ctx.host;
}

function ownerForeign(account: string, ctx: SetupContext): boolean {
  if (!ctx.owner || lower(ctx.owner) === lower(account)) return false;
  return !ctx.allowed.includes(lower(ctx.owner));
}

/** The addresses in history besides this account's, said as a count -- or that it couldn't be read. */
function historyNote(answers: Answers, ctx: SetupContext): string {
  if (!ctx.addresses.ok) {
    return 'this repository\'s commits could not be read (' + printable(ctx.addresses.error) + '), so repown can\'t say who else committed here';
  }
  if (ctx.addresses.value.size === 0) return 'this repository has no commits yet';
  const own = lower(emailOf(answers, ctx) ?? '');
  const others = [...ctx.addresses.value.keys()].filter((address) => lower(address) !== own).length;
  if (others === 0) return 'only your email address is in this repository\'s commits';
  return (others === 1 ? '1 other person\'s email address is' : others + ' other people\'s email addresses are') +
    ' in this repository\'s commits: the guard suits you if you push only your own commits; ' +
    'choose No if you push commits others made here';
}

function emailOf(answers: Answers, ctx: SetupContext): string | undefined {
  if (isNew(answers)) return typeof answers['email'] === 'string' ? answers['email'] : undefined;
  return ctx.recorded[accountOf(answers)]?.email;
}

function nameOf(answers: Answers, ctx: SetupContext): string | undefined {
  if (isNew(answers)) return typeof answers['name'] === 'string' ? answers['name'] : undefined;
  return ctx.recorded[accountOf(answers)]?.name;
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
    upstreamArgv(answers, ctx),
  ];
  return planned.filter((argv): argv is readonly string[] => argv !== null).map((argv) => ({ argv, what: whatOf(argv, answers, ctx) }));
}

function upstreamArgv(answers: Answers, ctx: SetupContext): string[] | null {
  if (answers['upstream'] !== true || !offersUpstream(ctx)) return null;
  return autoUpstreamLine(ctx);
}

function autoUpstreamLine(ctx: SetupContext): string[] {
  return ['git', ...(ctx.cwd ? ['-C', ctx.cwd] : []), 'config', '--local', 'push.autoSetupRemote', 'true'];
}

/** What a planned command does, in words for someone who has never used repown. */
function whatOf(argv: readonly string[], answers: Answers, ctx: SetupContext): string {
  const account = accountOf(answers);
  if (argv[0] === 'accounts') return 'Record the account ' + account + ' on this machine: ' + String(answers['email']);
  if (argv[0] === 'git') return gitWhat(argv, ctx);
  if (argv[0] === 'fix') return 'Stop gh answering git\'s sign-in requests (whole machine)';
  if (argv[0] === 'guard') return 'Turn on the push guard: each push is checked first';
  if (answers['gh'] === true) return ghWhat(account, ctx);
  return 'Pin this clone to ' + account + (ctx.credentialPinned ? ': its commit name, email and push sign-in' : ': its commit name and email');
}

function gitWhat(argv: readonly string[], ctx: SetupContext): string {
  if (argv.includes('push.autoSetupRemote')) return 'Push branches without -u: the first push sets the upstream (this clone only)';
  return 'Let this clone push to ' + ctx.owner + '\'s repositories';
}

function ghWhat(account: string, ctx: SetupContext): string {
  const pin = 'Pin this clone to ' + account + ', and ';
  if (inGh(account, ctx)) return pin + 'make it gh\'s active account';
  return pin + 'sign ' + account + ' in to gh (opens your browser)';
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

/**
 * Control characters, and the invisible or direction-changing ones, as visible escapes:
 * a value read from a remote URL must neither redraw the screen nor read as another name.
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
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
      notes: noted(settledNotes(answers, ctx), answers, ctx), settled: true };
  }
  return { title: 'Review: nothing has changed yet', headline: [printable(headline(answers, ctx))], steps,
    notes: noted(notes(answers, ctx), answers, ctx), settled: false };
}

function settledNotes(answers: Answers, ctx: SetupContext): string[] {
  const lines = ['Checked: the settings git uses here are ' + printable(accountOf(answers)) + '\'s, as recorded.',
    'See it any time: repown status (this clone), repown doctor (this machine)'];
  const offer = upstreamOffer(ctx);
  return offer ? [...lines, offer] : lines;
}

function upstreamOffer(ctx: SetupContext): string | null {
  if (!offersUpstream(ctx)) return null;
  return 'optional: push branches without -u: repown setup --auto-upstream';
}

function noted(lines: readonly string[], answers: Answers, ctx: SetupContext): string[] {
  const body = [...lines, ...extraNotes(answers, ctx)];
  return body.map(printable).concat(ghNote(answers, ctx));
}

function extraNotes(answers: Answers, ctx: SetupContext): string[] {
  const upstream = upstreamNote(ctx);
  return [...(upstream ? [upstream] : []), ...unpushedNote(answers, ctx)];
}

/** The address depends on the account, so the commits were read once and are compared here. */
function unpushedNote(answers: Answers, ctx: SetupContext): string[] {
  const email = emailOf(answers, ctx) ?? '';
  if (!email && ctx.unpushed.commits.ok) return [];
  return unpushedLines(ctx.unpushed, email);
}

/** Old git, or a version that could not be read: say the push the question would have replaced. */
function upstreamNote(ctx: SetupContext): string | null {
  if (ctx.upstream.supported) return null;
  const branch = ctx.upstream.branch ?? '<branch>';
  return 'the first push of a branch without an upstream needs: git push -u origin ' + branch;
}

/** gh still acts as someone else, and this run will not change that. */
function ghNote(answers: Answers, ctx: SetupContext): string[] {
  const line = ghLeft(answers, ctx);
  return line ? [printable(line)] : [];
}

/** Drop the leading "fix: " on ghAdvice's remedy, so a sentence can name it itself. */
export function dropFixPrefix(detail: string): string {
  return detail.replace(/^fix: /, '');
}

function ghLeft(answers: Answers, ctx: SetupContext): string | null {
  const gh = ctx.gh;
  if (answers['gh'] === true || !gh?.ok || !gh.value.active) return null;
  const advice = ghAdvice(accountOf(answers), { ghPresent: true, gh });
  if (!advice) return null;
  return 'gh still acts as ' + gh.value.active + ', so gh pr create here would act as that account (git pushes are unaffected). If you use gh here, later: ' + dropFixPrefix(advice.detail);
}

/**
 * Nothing to do: the only command left is pinning this clone to the account it is
 * already pinned to, as recorded and as git would use it (see pinIntact), with no
 * organisation the guard would refuse and gh nowhere in the helper list. Saying No
 * to push.autoSetupRemote still counts; the settled screen names the flag. Recommended
 * answers Yes, so that step is in the plan and the clone is not settled.
 * `use` may still say, on a host it can't pin, that it doesn't pin the sign-in.
 */
function settled(answers: Answers, ctx: SetupContext, plan: readonly PlannedCommand[]): boolean {
  const account = accountOf(answers);
  const onlyPin = plan.length === 1 && plan[0]!.argv[0] === 'use' && !plan[0]!.argv.includes('--gh');
  const same = !isNew(answers) && account === ctx.pinned && ctx.pinIntact;
  return onlyPin && same && !ctx.ghIsHelper && !ownerForeign(account, ctx);
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
  const pin = pinNote(account, ctx);
  if (pin) lines.push(pin);
  const guard = guardNote(answers, ctx);
  if (guard) lines.push(guard);
  const guarded = answers['guard'] === true || ctx.guard === 'on';
  if (guarded && ownerForeign(account, ctx) && answers['allowOwner'] !== true) {
    lines.push('Warning: the push guard will refuse pushes to "' + ctx.owner + '". To allow them later: ' +
      'git config --local --add repown.allowOwner ' + shellWord(ctx.owner!));
  }
  if (ctx.ghIsHelper && answers['fix'] !== true && ctx.credentialPinned) {
    lines.push('Note: gh is still git\'s credential helper, so pushes sign in as gh\'s active account, not ' + account + '.');
  }
  return lines;
}

/** What pinning changes for a clone pinned already: another account, or settings that drifted. */
function pinNote(account: string, ctx: SetupContext): string | null {
  if (!ctx.pinned) return null;
  if (lower(ctx.pinned) !== lower(account)) {
    return 'This clone moves from ' + ctx.pinned + ' to ' + account + ': its next commits and pushes use ' + account +
      '. Commits already made keep their author.';
  }
  return ctx.pinIntact ? null : 'This clone\'s settings differ from what is recorded for ' + account + ': pinning again restores them.';
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

// ------------------------------------------------- what one step would change

/** The config lines, or the gh action, a planned command writes. Pure. */
export function changesOf(argv: readonly string[], answers: Answers, ctx: SetupContext): string[] {
  if (argv[0] === 'accounts') return [registryChange(answers)];
  if (argv[0] === 'git') return [gitChange(argv)];
  if (argv[0] === 'fix') return fixChanges(ctx);
  if (argv[0] === 'guard') return [guardChange(ctx)];
  return useChanges(argv, answers, ctx);
}

/** The confirmation shown before a step in step-by-step mode. */
export function briefOf(planned: PlannedCommand, answers: Answers, ctx: SetupContext): StepConfirm {
  const command = formatCommand(planned.argv);
  return {
    changes: changesOf(planned.argv, answers, ctx).map(printable),
    why: printable(planned.what),
    command,
    initial: stepDefault(command),
  };
}

function registryChange(answers: Answers): string {
  const account = accountOf(answers);
  const name = String(answers['name'] ?? '');
  const email = String(answers['email'] ?? '');
  return 'this machine\'s account registry: ' + account + ' = ' + name + ' ' + email;
}

function gitChange(argv: readonly string[]): string {
  if (argv.includes('push.autoSetupRemote')) return 'push.autoSetupRemote = true';
  return 'repown.allowOwner += ' + (argv.at(-1) ?? '');
}

function fixChanges(ctx: SetupContext): string[] {
  return (ctx.fixLines ?? []).filter((line) => line.trim() !== '');
}

function guardChange(ctx: SetupContext): string {
  const hook = ctx.hookPath ?? 'this clone\'s pre-push hook';
  return 'pre-push hook: ' + hook + ' runs repown guard check';
}

function useChanges(argv: readonly string[], answers: Answers, ctx: SetupContext): string[] {
  const keys = ctx.credentialPinned ? ctx.credentialKeys : [];
  const lines = pinWrites(identityOf(answers, ctx), keys).map(([key, value]) => key + ' = ' + value);
  const gh = ghChange(argv, answers, ctx);
  return gh ? [...lines, gh] : lines;
}

function identityOf(answers: Answers, ctx: SetupContext): IdentityValues {
  return { name: nameOf(answers, ctx) ?? '', email: emailOf(answers, ctx) ?? '', account: accountOf(answers) };
}

function ghChange(argv: readonly string[], answers: Answers, ctx: SetupContext): string | null {
  if (!argv.includes('--gh')) return null;
  const account = accountOf(answers);
  if (inGh(account, ctx)) return 'gh: switch the active account to ' + account;
  return 'gh: sign in as ' + account + ' (opens a browser)';
}
