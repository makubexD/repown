// What `repown setup` asks, and what the answers turn into. Every answer becomes a
// flag or argument of a command that already exists -- `accounts add`, `use`,
// `guard on`, `fix` -- or a repo-local git line (an organisation's allowOwner, or
// push.autoSetupRemote), so the review can show exactly what will run, and a
// script can run the same thing.
//
// Pure: no I/O. What the clone and the machine look like arrives as a SetupContext
// (src/wizard/setup-context.ts), read before the first question.

import { ghAdvice, upstreamText } from '../commands/status.ts';
import { providers, type Profile } from '../core/hosts/index.ts';
import { isNoreplyAddress } from '../core/hosts/github.ts';
import { ALLOW_OWNER_BY_HAND, allowOwnerCommand, shellWord } from '../core/guard/check.ts';
import { printable } from '../ui/format.ts';
import { foreignAddresses, foreignCount, type UnpushedFact } from '../core/unpushed.ts';
import type { PushFacts } from '../core/push-state.ts';
import { blockers, type Blocker } from '../core/blockers.ts';
import type { Account } from '../core/registry.ts';
import type { GhState } from '../core/credential/gh.ts';
import type { GuardState } from '../core/guard/hook.ts';
import type { Result } from '../core/result.ts';
import { pinWrites, type IdentityValues } from '../core/identity.ts';
import { stepDefault } from './review-text.ts';
import type { Answers, Choice, Flow, Resume, Review, Step, StepConfirm } from './engine.ts';

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
  /** What else decides whether the next commit, pull or push works (blockers.ts). */
  readonly push: Omit<PushFacts, 'unpushed'>;
  /** Global `user.name` and `user.email`. Shown, never assumed to be this account. */
  readonly machineIdentity: { readonly name: string | null; readonly email: string | null };
  /** Git's `push.autoSetupRemote`: whether this git has it, the effective value, the branch. */
  readonly upstream: UpstreamRead;
  /** GCM's stored GitHub accounts. Null when the store was not read; an error when it could not be. */
  readonly stored: Result<readonly string[]> | null;
  suggest(account: string, host: string): Promise<Suggestion>;
  /** The github.com logins gh and GCM are signed in as (signedInLogins), read when first asked. */
  signedIn(): Promise<readonly string[] | null>;
}

/** A profile lookup's suggestion, and a sentence when the host says the login is no account or an organisation. */
export interface Suggestion extends Profile {
  readonly problem?: string | null;
}

/** What recording a new account asks with: setup's context, or the start screen's. */
export type AccountContext = Pick<SetupContext, 'recorded' | 'host' | 'machineIdentity' | 'suggest' | 'signedIn'>;

/**
 * Every github.com login gh or Git Credential Manager is signed in as, once each (any
 * case). Null when neither could be read: a skipped read is never "signed in as nobody".
 */
export function signedInLogins(gh: Result<GhState> | null, stored: Result<readonly string[]> | null): string[] | null {
  const lists = [gh?.ok ? gh.value.accounts.map((account) => account.login) : null, stored?.ok ? stored.value : null];
  const read = lists.filter((list): list is readonly string[] => list !== null);
  if (read.length === 0) return null;
  const byCase = new Map<string, string>();
  for (const login of read.flat()) if (!byCase.has(login.toLowerCase())) byCase.set(login.toLowerCase(), login);
  return [...byCase.values()];
}

/** Read once, before the first question. `supported` is false when the version cannot be read. */
export interface UpstreamRead {
  readonly supported: boolean;
  /** Effective `push.autoSetupRemote`, or null when unset. */
  readonly enabled: boolean | null;
  /** The current branch, when HEAD names one. */
  readonly branch: string | null;
  /** The branch's tracked ref (`origin/main`), or null when none is set or HEAD is not a branch. */
  readonly tracked: string | null;
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
  return {
    steps: steps(ctx), review: (answers) => review(answers, ctx), fill: (answers) => recommendedAnswers(answers, ctx),
    opening: () => openingReview(ctx), resume: (choice) => resumeAt(choice, ctx),
  };
}

function openingReview(ctx: SetupContext): Review | null {
  if (!ctx.pinned || !ctx.pinIntact) return null;
  const shown = review(recommendedAnswers({ mode: 'recommended', account: ctx.pinned }, ctx), ctx);
  return shown.settled ? { ...shown, edits: false } : null;
}

function resumeAt(choice: Resume, ctx: SetupContext): { readonly answers: Answers; readonly start: number } {
  if (choice === 'gh') return { answers: ghAnswers(ctx), start: steps(ctx).length };
  if (choice === 'reauthor') return { answers: reauthorAnswers(ctx), start: steps(ctx).length };
  const start = steps(ctx).findIndex((step) => step.id === 'account');
  return { answers: { mode: 'recommended' }, start: start < 0 ? 0 : start };
}

/** The settled screen's Re-author them: the pinned account's answers, with that one step. */
function reauthorAnswers(ctx: SetupContext): Answers {
  return recommendedAnswers({ mode: 'recommended', account: ctx.pinned ?? '', reauthor: true }, ctx);
}

function ghAnswers(ctx: SetupContext): Answers {
  return recommendedAnswers({ mode: 'recommended', account: ctx.pinned ?? '', gh: true }, ctx);
}

/** Yes for confirms Recommended skips. An answer already given, including from Change an answer, stays. */
export function recommendedAnswers(answers: Answers, ctx: SetupContext): Answers {
  if (!isRecommended(answers)) return answers;
  const filled = { ...answers };
  for (const step of steps(ctx)) fillRecommended(step, filled, ctx);
  return filled;
}

function fillRecommended(step: Step<SetupContext>, filled: Answers, ctx: SetupContext): void {
  if (filled[step.id] !== undefined || step.skip?.(filled, ctx)) return;
  if (!step.auto?.(filled, ctx)) return;
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
    ...profileSteps(ctx),
    ...choiceSteps(ctx),
  ];
}

/** A new account's login, refused when already recorded. The start screen asks it too. */
export function loginStep<C>(ctx: AccountContext): Step<C> {
  return {
    id: 'newAccount', kind: 'text', flag: '<account>', message: 'The account\'s user name (login)',
    hint: 'the name you sign in with, e.g. octocat; not your email address',
    validate: (value) => newAccountProblem(String(value), ctx),
  };
}

/** Where a new account is hosted, and its commit name and email. The start screen asks these too. */
export function profileSteps<C>(ctx: AccountContext): Step<C>[] {
  return [
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
  ];
}

export interface NewAccount {
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly host: string;
}

/** A new account from the answers that ask for one. */
export function newAccountOf(answers: Answers, ctx: AccountContext): NewAccount {
  return { login: accountOf(answers), name: String(answers['name']), email: String(answers['email']), host: hostOf(answers, ctx) };
}

/** `accounts add` with every answer as a flag, so it asks nothing; `--` keeps a dashed login the account. */
export function addAccountArgv(account: NewAccount): string[] {
  return ['accounts', 'add', '--name=' + account.name, '--email=' + account.email, '--host=' + account.host, '--', account.login];
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
    { ...loginStep<SetupContext>(ctx), when: (answers) => asksForLogin(answers), initial: () => ownerInitial(ctx) },
  ];
}

function choiceSteps(ctx: SetupContext): Step<SetupContext>[] {
  return [
    repointStep(ctx),
    fetchStep(ctx),
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
    reauthorStep(ctx),
  ];
}

/** Never answered by Recommended: only the user knows whether they made those commits. */
function reauthorStep(ctx: SetupContext): Step<SetupContext> {
  return {
    id: 'reauthor', kind: 'confirm', flag: '--reauthor', initial: () => false,
    message: (answers) => 'Re-author your unpushed commits by ' + printable(othersOf(answers, ctx).join(', ')) +
      ' as ' + printable(accountOf(answers)) + '?',
    hint: 'only if you made them: they get this account\'s name and email. repown fetches first, rewrites only ' +
      'what no remote has, keeps a backup, and never pushes',
    when: (answers) => reauthorOffered(answers, ctx),
  };
}

/**
 * `--repoint`, `--fetch` and `--reauthor` apply only where their step would be asked; elsewhere
 * each is turned off with a note saying why. Read before any question, so a repoint not yet
 * answered counts as the Yes Recommended gives it (a later No drops the fetch from the plan).
 */
export function keptFlags(given: Answers, ctx: SetupContext): { readonly answers: Answers; readonly notes: string[] } {
  const answers = { ...given };
  const notes: string[] = [];
  const drop = (key: string, note: string): void => { answers[key] = false; notes.push('--' + key + ': ' + note); };
  if (answers['repoint'] === true && !ctx.push.repoint) drop('repoint', 'this branch does not push to a URL that a remote here names, so there is nothing to repoint');
  if (answers['fetch'] === true && fetchTarget({ ...answers, repoint: answers['repoint'] ?? true }, ctx) === null) drop('fetch', fetchDropped(answers, ctx));
  if (answers['reauthor'] === true && !reauthorOffered(answers, ctx)) drop('reauthor', 'no unpushed commit here is by another address, so there is nothing to re-author');
  return { answers, notes };
}

function fetchDropped(answers: Answers, ctx: SetupContext): string {
  if (answers['repoint'] === false && fetchTarget({ ...answers, repoint: true }, ctx) !== null) {
    return 'this branch pushes to a URL, so fetching ' + printable(ctx.push.repoint!.remote) + ' tells nothing about it: add --repoint';
  }
  return 'no commit by another address waits behind a remote this clone has never fetched, so there is nothing to fetch';
}

/** Some unpushed commits carry an address other than the chosen account's. */
export function reauthorOffered(answers: Answers, ctx: SetupContext): boolean {
  return othersOf(answers, ctx).length > 0;
}

function othersOf(answers: Answers, ctx: SetupContext): readonly string[] {
  return foreignAddresses(ctx.unpushed, emailOf(answers, ctx) ?? '');
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

/**
 * On GitHub: the private address when that is what the email starts as, else where to
 * find it, for someone who has never looked.
 */
async function noreplyNote(answers: Answers, ctx: AccountContext): Promise<string | undefined> {
  if (hostOf(answers, ctx) !== 'github') return undefined;
  const account = printable(accountOf(answers));
  const { email } = await ctx.suggest(accountOf(answers), 'github');
  if (email && isNoreplyAddress(email) && typeof answers['email'] !== 'string') return 'prefilled with the private address GitHub gives ' + account + ' (github.com/settings/emails)';
  return 'tip: to keep your own address private, use the one GitHub gives you, shown at ' +
    'github.com/settings/emails, like 1234+' + account + '@users.noreply.github.com';
}

/**
 * First what the host said about the login (no such account, an organisation), so Back
 * can fix a typo before anything is recorded; else whether this machine is signed in as
 * someone else, and whether the name starts as the login; then the machine's name, never this account's initial value.
 */
async function nameDetail(answers: Answers, ctx: AccountContext): Promise<string | undefined> {
  if (!isNew(answers)) return undefined;
  const found = await ctx.suggest(accountOf(answers), hostOf(answers, ctx));
  const leads = found.problem ? [printable(found.problem)] : [await notSignedIn(answers, ctx), loginPrefill(answers, found, ctx)];
  const parts = [...leads, machineName(ctx)].filter((part) => part);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** On GitHub, when this machine is signed in as other logins only: perhaps not this person's account. */
async function notSignedIn(answers: Answers, ctx: AccountContext): Promise<string | null> {
  if (hostOf(answers, ctx) !== 'github') return null;
  const logins = await ctx.signedIn();
  const login = accountOf(answers);
  if (!logins || logins.length === 0 || logins.some((other) => other.toLowerCase() === login.toLowerCase())) return null;
  const shown = printable(login);
  return 'signed in as ' + logins.map(printable).join(', ') + ', not ' + shown + ': if ' + shown +
    ' isn\'t your account, go back; otherwise the first push asks you to sign in as it';
}

/** Said when the name question starts as the login: no profile name was found. */
function loginPrefill(answers: Answers, found: Suggestion, ctx: AccountContext): string | null {
  if (found.name || typeof answers['name'] === 'string') return null;
  const answered = found.email !== undefined && hostOf(answers, ctx) === 'github';
  return answered ? 'GitHub shows no name for ' + printable(accountOf(answers)) + ', so this is the login' : 'this is the login';
}

function machineName(ctx: AccountContext): string | null {
  const name = ctx.machineIdentity.name;
  return name ? 'your default git name here is ' + printable(name) + ': use it only if this account does too' : null;
}

/** The private-address note first, then the machine address. Two sentences; both prompters wrap one detail. */
async function emailDetail(answers: Answers, ctx: AccountContext): Promise<string | undefined> {
  const tip = await noreplyNote(answers, ctx);
  const line = addressDetail(answers, ctx);
  if (tip && line) return tip + '; ' + line;
  return tip ?? line;
}

function addressDetail(answers: Answers, ctx: AccountContext): string | undefined {
  const email = ctx.machineIdentity.email;
  if (!isNew(answers) || !email) return undefined;
  return 'your default git address here is ' + printable(email) + ': use it only if this account does too';
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

function repointStep(ctx: SetupContext): Step<SetupContext> {
  const target = ctx.push.repoint;
  return {
    id: 'repoint', kind: 'confirm', flag: '--repoint', initial: () => true, auto: isRecommended,
    message: 'Push through ' + printable(target?.remote ?? '') + ' instead of the URL set for this branch?',
    hint: 'that URL names the same repository as ' + printable(target?.remote ?? '') + ', but it can carry its own sign-in, so ' +
      'pushes would not sign in as this account, and it is never fetched. Changes ' + printable(target?.key ?? '') + ', this clone only',
    when: () => target !== null,
  };
}

function fetchStep(ctx: SetupContext): Step<SetupContext> {
  return {
    id: 'fetch', kind: 'confirm', flag: '--fetch', initial: () => true, auto: isRecommended,
    message: (answers) => 'Fetch ' + printable(fetchTarget(answers, ctx) ?? '') + ' first?',
    hint: (answers) => 'so repown can tell which of your unpushed commits ' + printable(fetchTarget(answers, ctx) ?? '') +
      ' already has; downloads only, moves none of your branches, and never asks for a password',
    when: (answers) => fetchTarget(answers, ctx) !== null,
  };
}

/**
 * The remote to fetch before counting: commits by another address, behind a remote no
 * tracking ref reaches -- the destination itself, or the remote a repoint makes it.
 */
export function fetchTarget(answers: Answers, ctx: SetupContext): string | null {
  if (foreignCount(ctx.unpushed, emailOf(answers, ctx) ?? '') === 0) return null;
  const unknown = ctx.unpushed.unknown;
  if (unknown?.kind === 'remote') return unknown.name;
  const repoint = ctx.push.repoint;
  if (unknown?.kind !== 'url' || !repoint || repoint.tracked || answers['repoint'] !== true) return null;
  return repoint.remote;
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
    auto: (answers) => ghAuto(answers, ctx),
    skip: (answers) => ghSkipped(answers, ctx),
  };
}

function ghAuto(answers: Answers, ctx: SetupContext): boolean {
  return isRecommended(answers) && inGh(accountOf(answers), ctx) && !sameAccount(answers, ctx);
}

/** Recommended leaves gh at No when this clone is already pinned to the chosen account. */
function ghSkipped(answers: Answers, ctx: SetupContext): boolean {
  return isRecommended(answers) && sameAccount(answers, ctx);
}

function sameAccount(answers: Answers, ctx: SetupContext): boolean {
  return ctx.pinned !== null && !isNew(answers) && accountOf(answers) === ctx.pinned;
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

/** Empty, or not spelled as a login. The start screen asks for a login by this rule too. */
export function loginProblem(value: string): string | null {
  if (!value.trim()) return 'a value is required';
  return LOGIN.test(value) ? null : 'use letters, digits and . _ @ - only';
}

function newAccountProblem(value: string, ctx: AccountContext): string | null {
  const problem = loginProblem(value);
  if (problem) return problem;
  const clash = Object.keys(ctx.recorded).find((account) => lower(account) === lower(value));
  return clash ? '"' + clash + '" is already recorded on this machine: use it by that name' : null;
}

function hostOf(answers: Answers, ctx: AccountContext): string {
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
    repointArgv(answers, ctx),
    fetchArgv(answers, ctx),
    isNew(answers) ? addAccountArgv(newAccountOf(answers, ctx)) : null,
    answers['allowOwner'] === true && ctx.owner ? allowOwnerLine(ctx) : null,
    answers['fix'] === true ? ['fix', '--yes', ...cwd] : null,
    useArgv(answers, ctx),
    answers['guard'] === true ? ['guard', 'on', ...cwd] : null,
    upstreamArgv(answers, ctx),
    answers['reauthor'] === true && reauthorOffered(answers, ctx) ? ['reauthor', '--yes', ...cwd] : null,
  ];
  return planned.filter((argv): argv is readonly string[] => argv !== null).map((argv) => ({ argv, what: whatOf(argv, answers, ctx) }));
}

/** A pin that would write nothing is left out. `use --gh` still runs: that step changes gh. */
export function pinUnchanged(answers: Answers, ctx: SetupContext): boolean {
  return sameAccount(answers, ctx) && ctx.pinIntact && answers['gh'] !== true;
}

function useArgv(answers: Answers, ctx: SetupContext): readonly string[] | null {
  if (pinUnchanged(answers, ctx)) return null;
  const cwd = ctx.cwd ? ['--cwd=' + ctx.cwd] : [];
  const gh = answers['gh'] === true ? ['--gh'] : [];
  return ['use', ...gh, ...cwd, '--', accountOf(answers)];
}

function upstreamArgv(answers: Answers, ctx: SetupContext): string[] | null {
  if (answers['upstream'] !== true || !offersUpstream(ctx)) return null;
  return autoUpstreamLine(ctx);
}

function gitIn(ctx: SetupContext): string[] {
  return ['git', ...(ctx.cwd ? ['-C', ctx.cwd] : [])];
}

function autoUpstreamLine(ctx: SetupContext): string[] {
  return [...gitIn(ctx), 'config', '--local', 'push.autoSetupRemote', 'true'];
}

function repointArgv(answers: Answers, ctx: SetupContext): string[] | null {
  const target = ctx.push.repoint;
  if (answers['repoint'] !== true || !target) return null;
  return [...gitIn(ctx), 'config', '--local', target.key, target.remote];
}

function fetchArgv(answers: Answers, ctx: SetupContext): string[] | null {
  const remote = answers['fetch'] === true ? fetchTarget(answers, ctx) : null;
  return remote ? [...gitIn(ctx), 'fetch', remote] : null;
}

/** Which of setup's git lines this is, read from its shape; null for anything setup does not plan. */
export type GitStep = 'repoint' | 'fetch' | 'upstream' | 'allowOwner';

export function gitStepOf(argv: readonly string[]): GitStep | null {
  const sub = argv[1] === '-C' ? argv.slice(3) : argv.slice(1);
  if (sub[0] === 'fetch' && sub.length === 2) return 'fetch';
  if (sub[0] !== 'config' || sub[1] !== '--local') return null;
  if (sub[2] === '--add' && sub[3] === 'repown.allowOwner' && sub.length === 5) return 'allowOwner';
  if (sub[2] === 'push.autoSetupRemote' && sub.length === 4) return 'upstream';
  return sub.length === 4 ? 'repoint' : null;
}

/** What a planned command does, in words for someone who has never used repown. */
function whatOf(argv: readonly string[], answers: Answers, ctx: SetupContext): string {
  const account = accountOf(answers);
  if (argv[0] === 'accounts') return 'Record the account ' + account + ' on this machine: ' + String(answers['email']);
  if (argv[0] === 'git') return gitWhat(argv, ctx);
  if (argv[0] === 'fix') return 'Stop gh answering git\'s sign-in requests (whole machine)';
  if (argv[0] === 'guard') return 'Turn on the push guard: each push is checked first';
  if (argv[0] === 'reauthor') return 'Re-author your unpushed commits by other addresses as ' + account + ' (a backup is kept; nothing is pushed)';
  if (answers['gh'] === true) return ghWhat(account, ctx);
  return 'Pin this clone to ' + account + (ctx.credentialPinned ? ': its commit name, email and push sign-in' : ': its commit name and email');
}

function gitWhat(argv: readonly string[], ctx: SetupContext): string {
  const step = gitStepOf(argv);
  if (step === 'repoint') return 'Push through ' + argv.at(-1) + ' instead of the URL in ' + argv.at(-2) + ' (this clone only)';
  if (step === 'fetch') return 'Fetch ' + argv.at(-1) + ', so repown can tell which commits it already has';
  if (step === 'upstream') return 'Push branches without -u: the first push sets the upstream (this clone only)';
  return 'Let this clone push to ' + ctx.owner + '\'s repositories';
}

function ghWhat(account: string, ctx: SetupContext): string {
  const pin = 'Pin this clone to ' + account + ', and ';
  if (inGh(account, ctx)) return pin + 'make it gh\'s active account';
  return pin + 'sign ' + account + ' in to gh (opens your browser)';
}

function allowOwnerLine(ctx: SetupContext): string[] {
  return [...gitIn(ctx), 'config', '--local', '--add', 'repown.allowOwner', ctx.owner!];
}

/** Shown in place of a word no quoting keeps literal in every shell (shellWord): it has run, or will, but don't paste it. */
export const UNQUOTABLE = '[value not safe to paste]';

function wordOf(value: string): string {
  return shellWord(value) ?? UNQUOTABLE;
}

/**
 * The command as you would type it: the account where it reads naturally, options
 * as `--name value`, and `--host github` left out because it's the default. A `--`
 * before a dashed account comes out quoted (shellWord).
 */
export function formatCommand(argv: readonly string[]): string {
  if (argv[0] === 'git') return printable(argv.map(wordOf).join(' '));
  const end = argv.indexOf('--');
  const head = end < 0 ? argv : argv.slice(0, end);
  const positional = end < 0 ? [] : argv.slice(end + 1);
  const dashed = positional.some((value) => value.startsWith('-'));
  const path = head.filter((token) => !token.startsWith('-')).map(wordOf);
  const options = head.filter((token) => token.startsWith('-') && token !== '--host=github').flatMap(splitOption).map(wordOf);
  const accounts = positional.map(wordOf);
  const words = dashed ? [...path, ...options, wordOf('--'), ...accounts] : [...path, ...accounts, ...options];
  return printable(['repown', ...words].join(' '));
}

/** Setup's own importers read it from here; the one definition is in the output helpers. */
export { printable };

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
  const steps = stepsOf(plan, ctx);
  return settled(answers, ctx, plan) ? settledReview(answers, ctx, steps, plan) : pendingReview(answers, ctx, steps, plan);
}

function stepsOf(plan: readonly PlannedCommand[], ctx: SetupContext): Review['steps'] {
  return plan.map((command) => ({
    what: printable(command.what), command: formatCommand(command.argv),
    detail: command.argv[0] === 'fix' ? (ctx.fixLines ?? []).map(printable) : [],
  }));
}

function pendingReview(answers: Answers, ctx: SetupContext, steps: Review['steps'], plan: readonly PlannedCommand[]): Review {
  return {
    title: 'Review: nothing has changed yet', headline: [printable(headline(answers, ctx))], steps,
    notes: [...noted(notes(answers, ctx), answers, ctx, plan), ...ghNote(answers, ctx, false)], settled: false,
  };
}

function settledReview(answers: Answers, ctx: SetupContext, steps: Review['steps'], plan: readonly PlannedCommand[]): Review {
  const offer = ghOffer(accountOf(answers), ctx);
  const reauthor = reauthorOffered(answers, ctx) ? { reauthorOffer: 'Re-author them as ' + printable(accountOf(answers)) } : {};
  const shown: Review = {
    ...reauthor,
    title: 'This clone is already set up', headline: settledLines(answers, ctx).map(printable), steps,
    notes: [...noted(settledNotes(answers, ctx), answers, ctx, plan), ...ghNote(answers, ctx, true)], settled: true,
    blocked: blockersOf(answers, ctx).some((blocker) => blocker.blocks),
  };
  return offer ? { ...shown, ghSignIn: offer } : shown;
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

/** What blocks the next push first (ADR-026), then the step's own notes. */
function noted(lines: readonly string[], answers: Answers, ctx: SetupContext, plan: readonly PlannedCommand[]): string[] {
  const gap = credentialGap(plan, answers, ctx);
  const found = blockersOf(answers, ctx);
  const upstream = found.some((blocker) => blocker.summary.endsWith('has no upstream')) ? null : upstreamNote(ctx);
  const body = [...found.flatMap((blocker) => blocker.lines), ...lines, ...(upstream ? [upstream] : []), ...(gap ? [gap] : [])];
  return body.map(printable);
}

/** The address depends on the account, so the commits were read once and are compared here. */
export function blockersOf(answers: Answers, ctx: SetupContext): Blocker[] {
  const email = emailOf(answers, ctx) ?? '';
  const unpushed = email || !ctx.unpushed.commits.ok ? ctx.unpushed : { ...ctx.unpushed, branch: null };
  const autoUpstream = answers['upstream'] === true || ctx.upstream.enabled === true;
  const guarded = answers['guard'] === true || ctx.guard !== 'off' || ctx.redirected;
  return blockers({ ...ctx.push, unpushed }, { email, account: accountOf(answers), autoUpstream, guarded });
}

/** use's own line, said here only when this run will not run use. Mirrors use.ts credentialConcern. */
function credentialGap(plan: readonly PlannedCommand[], answers: Answers, ctx: SetupContext): string | null {
  if (plan.some((command) => command.argv[0] === 'use') || !ctx.credentialPinned || !ctx.stored?.ok) return null;
  const account = accountOf(answers);
  if (ctx.stored.value.includes(account)) return null;
  return 'No stored credential for ' + account + ' yet: the first push signs in once (your browser opens).';
}

/** Old git, or a version that could not be read: say the push the question would have replaced. */
function upstreamNote(ctx: SetupContext): string | null {
  if (ctx.upstream.supported) return null;
  const branch = ctx.upstream.branch ?? '<branch>';
  return 'the first push of a branch without an upstream needs: git push -u origin ' + branch;
}

/** gh still acts as someone else, and this run will not change that. */
function ghNote(answers: Answers, ctx: SetupContext, onSettled: boolean): string[] {
  const line = ghLeft(answers, ctx, onSettled);
  return line ? [printable(line)] : [];
}

/** True when the review already says how to point gh at this account, so the run does not say it again. */
export function ghNoted(answers: Answers, ctx: SetupContext): boolean {
  return ghLeft(answers, ctx, false) !== null;
}

/** Drop the leading "fix: " on ghAdvice's remedy, so a sentence can name it itself. */
export function dropFixPrefix(detail: string): string {
  return detail.replace(/^fix: /, '');
}

function ghLeft(answers: Answers, ctx: SetupContext, onSettled: boolean): string | null {
  const gh = ctx.gh;
  if (answers['gh'] === true || !gh?.ok || !gh.value.active) return null;
  const advice = ghAdvice(accountOf(answers), { ghPresent: true, gh });
  if (!advice) return null;
  return ghSentence(gh.value.active, ghEnding(accountOf(answers), ctx, advice.detail, onSettled));
}

function ghSentence(active: string, ending: string): string {
  return 'gh still acts as ' + active + ', so gh pr create here would act as that account (git pushes are unaffected). ' + ending;
}

/** The settled screen points at its menu. Every other review names the command. */
function ghEnding(account: string, ctx: SetupContext, detail: string, onSettled: boolean): string {
  const offer = onSettled ? ghOffer(account, ctx) : null;
  if (offer !== null) return 'If you use gh here, choose "' + offer + '" below.';
  return 'If you use gh here: ' + ghRemedy(detail) + '.';
}

function ghRemedy(detail: string): string {
  return dropFixPrefix(detail).replace(/ {2,}/g, ' ');
}

/**
 * Nothing to do: the plan is empty because the pin would change nothing, with no
 * organisation the guard would refuse and gh nowhere in the helper list. Saying No
 * to push.autoSetupRemote still counts; the settled screen names the flag. Recommended
 * answers Yes, so that step is in the plan and the clone is not settled.
 */
function settled(answers: Answers, ctx: SetupContext, plan: readonly PlannedCommand[]): boolean {
  if (plan.length > 0 || !pinUnchanged(answers, ctx)) return false;
  return !ctx.ghIsHelper && !ownerForeign(accountOf(answers), ctx);
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
    ...upstreamSettled(ctx),
  ];
}

function upstreamSettled(ctx: SetupContext): string[] {
  const text = upstreamText(ctx.upstream.tracked, ctx.upstream.enabled);
  return text === null ? [] : ['upstream    ' + text];
}

function ghOffer(account: string, ctx: SetupContext): string | null {
  if (!otherGh(account, ctx)) return null;
  return inGh(account, ctx) ? 'Make ' + account + " gh's active account" : 'Sign in to gh as ' + account;
}

function otherGh(account: string, ctx: SetupContext): boolean {
  if (ctx.host !== 'github' || !ctx.gh?.ok || !ctx.gh.value.active) return false;
  return lower(ctx.gh.value.active) !== lower(account);
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
    lines.push('Warning: the push guard will refuse pushes to "' + printable(ctx.owner!) + '". To allow them later: ' +
      (allowOwnerCommand(ctx.owner!) ?? ALLOW_OWNER_BY_HAND));
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
  if (argv[0] === 'reauthor') return [reauthorChange(answers, ctx)];
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
  const step = gitStepOf(argv);
  if (step === 'repoint') return argv.at(-2) + ' = ' + argv.at(-1);
  if (step === 'fetch') return 'refs/remotes/' + argv.at(-1) + '/*: updated from ' + argv.at(-1) + ' (none of your branches move)';
  if (step === 'upstream') return 'push.autoSetupRemote = true';
  return 'repown.allowOwner += ' + (argv.at(-1) ?? '');
}

function reauthorChange(answers: Answers, ctx: SetupContext): string {
  const branch = ctx.unpushed.branch ?? 'this branch';
  return branch + ': unpushed commits by ' + othersOf(answers, ctx).join(', ') + ' get ' + (emailOf(answers, ctx) ?? '') +
    '; the original stays at refs/repown/backup/' + branch + '/<time>';
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
