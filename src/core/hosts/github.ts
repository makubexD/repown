// GitHub. The one host whose mechanics were established empirically rather than
// assumed -- see ADR-001.
//
// The pin is `credential.https://github.com.username`, which Git Credential
// Manager reads to choose between the credentials it stores, one per account,
// keyed `git:https://<user>@github.com`. That is what makes switching
// unnecessary: each clone authenticates as its own account, permanently.
//
// Over SSH there is no credential helper at all -- the SSH key decides -- so an
// SSH remote pins no credential key rather than one that selects nothing.

import type { AccountKind, HostProvider, Profile } from './types.ts';
import type { GitUrl } from '../url.ts';
import { credentialPrefix } from '../url.ts';
import { fieldOf, ghUser, type ProfileLookup, type UserLookup } from '../credential/gh.ts';
import { printable } from '../../ui/format.ts';

const HOSTS = ['github.com', 'gist.github.com', 'www.github.com', 'ssh.github.com'];

export function githubProvider(): HostProvider {
  return {
    id: 'github',
    label: 'GitHub',
    matches: (url: GitUrl) => HOSTS.includes(url.host),
    ownerOf: (url: GitUrl) => url.segments[0] ?? null,
    credentialKeys,
    resolveProfile,
    accountKind,
    lookUp,
  };
}

function credentialKeys(url: GitUrl): readonly string[] {
  return url.scheme === 'https' ? [`credential.${credentialPrefix(url)}.username`] : [];
}

/**
 * GitHub's own login shape (an underscore for Enterprise Managed Users). Nothing else is
 * looked up: a typed `../user` would make `users/../user` GitHub's own `/user`, the
 * signed-in account, and suggest its name and address for another login.
 */
export function githubLogin(login: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(login);
}

type ReadField = (login: string, field: string) => Promise<string | null>;

function resolveProfile(account: string): Promise<Profile | null> {
  return profileFrom(account, reader(once(account)));
}

/** The profile and what kind of account it is, from one `gh api` call. */
async function lookUp(login: string): Promise<{ profile: Profile | null; kind: AccountKind | null }> {
  const user = once(login);
  const [profile, kind] = await Promise.all([profileFrom(login, reader(user)), kindFrom(login, looker(user))]);
  return { profile, kind };
}

/** One `gh api users/<login>` however many fields are read, and none if no field is. */
function once(login: string): () => Promise<UserLookup> {
  let asked: Promise<UserLookup> | undefined;
  return () => (asked ??= ghUser(login));
}

function reader(user: () => Promise<UserLookup>): ReadField {
  return async (_login, field) => fieldOf(await user(), field).value;
}

function looker(user: () => Promise<UserLookup>): LookUp {
  return async (_login, field) => fieldOf(await user(), field);
}

/**
 * The suggestion for a GitHub-shaped login. A name that printable() would change (control,
 * bidi, zero-width characters) is dropped: it would be drawn, and saved if accepted.
 */
export async function profileFrom(account: string, read: ReadField): Promise<Profile | null> {
  if (!githubLogin(account)) return null;
  const [found, id] = await Promise.all([read(account, 'name'), read(account, 'id')]);
  const name = found && printable(found) === found ? found : null;
  // GitHub's own noreply address: publishable by design, and it still links
  // the commit to the account. Offered as a default so a private address
  // need never be published to get working attribution.
  const email = id && /^\d+$/.test(id) ? `${id}+${account}@users.noreply.github.com` : undefined;
  if (!name && !email) return null;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

/** The address GitHub gives an account to keep its own private (with or without the id in front). */
export function isNoreplyAddress(email: string): boolean {
  return /^(\d+\+)?[^@\s]+@users\.noreply\.github\.com$/i.test(email);
}

/**
 * The users endpoint answers for an organisation too, with type Organization.
 * Anything else, including a failed call, is unknown -- not a user.
 */
function accountKind(login: string): Promise<AccountKind | null> {
  return kindFrom(login, looker(once(login)));
}

type LookUp = (login: string, field: string) => Promise<ProfileLookup>;

/**
 * What github.com says a login is. One GitHub can't have (a dot, a slash, a leading dash)
 * is missing without asking: the typo still gets its sentence, and nothing reaches the API.
 */
export async function kindFrom(login: string, lookup: LookUp): Promise<AccountKind | null> {
  if (!githubLogin(login)) return 'missing';
  const found = await lookup(login, 'type');
  if (found.missing) return 'missing';
  if (found.value === 'User') return 'user';
  if (found.value === 'Organization') return 'organization';
  return null;
}
