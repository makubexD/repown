// Everything this tool asks of git, in one place.
//
// Bound to a working directory rather than reading a global: every command runs
// against an explicit clone, `repown scan` walks seventeen of them in one process,
// and the pre-push hook runs inside whichever worktree git invoked it from.
//
// STRIP-ONLY TYPESCRIPT throughout this project: no parameter properties, no
// enums, no namespaces -- nothing that needs code GENERATED rather than types
// removed. That keeps every source file runnable by bare `node`, which is what
// lets the pre-push hook and the tests run without a build step standing
// between a change and its verification.
//
// `git config --get` EXITS 1 WHEN A KEY IS NOT SET. That is an answer, not a
// failure, and it is why nothing here treats a non-zero code as an error by
// itself. See the note in exec.ts.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run, succeeded, output, lines, type ExecResult } from './exec.ts';
import { ok, err, type Result } from './result.ts';

export type ConfigScope = 'local' | 'global' | 'system';

export interface CommitIdentity {
  readonly sha: string;
  readonly subject: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
}

export interface ConfigEntry {
  readonly file: string;
  readonly key: string;
  readonly value: string;
}

/** What HEAD points at. An unborn branch still has a name; a detached HEAD has only a commit. */
export type CurrentBranch =
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'detached'; readonly hash: string };

export class Git {
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /** Every short git call. A ConfigSnapshot answers plain config reads here instead (ADR-029). */
  protected exec(args: readonly string[], input?: string): Promise<ExecResult> {
    return this.spawnGit(args, input);
  }

  /**
   * Starts the git child for exec() (execLong starts its own, for fetch and ls-remote).
   * --no-replace-objects on every call: `git replace` changes what git SHOWS for
   * an object, never what a push SENDS, so a replaced foreign commit read as the
   * clean replacement while the original was published.
   */
  protected spawnGit(args: readonly string[], input?: string): Promise<ExecResult> {
    const full = ['--no-replace-objects', ...args];
    return input === undefined
      ? run('git', full, { cwd: this.cwd })
      : run('git', full, { cwd: this.cwd, input });
  }

  // ---- location -----------------------------------------------------------

  async isRepo(): Promise<boolean> {
    return succeeded(await this.exec(['rev-parse', '--git-dir']));
  }

  /** No work tree to pin a commit identity in. A failed rev-parse is not bare. */
  async isBare(): Promise<boolean> {
    return output(await this.exec(['rev-parse', '--is-bare-repository'])) === 'true';
  }

  /** The working tree root. Asked of git so a linked worktree resolves to itself. */
  async root(): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--show-toplevel']));
  }

  /**
   * `symbolic-ref` answers with the branch name even when that branch has no
   * commits yet. Detached HEAD is not a symbolic ref, so the short hash names it.
   */
  async currentBranch(): Promise<CurrentBranch | null> {
    const name = output(await this.exec(['symbolic-ref', '--short', '-q', 'HEAD']));
    if (name) return { kind: 'branch', name };
    const hash = output(await this.exec(['rev-parse', '--short', 'HEAD']));
    return hash ? { kind: 'detached', hash } : null;
  }

  /** `git --version`, or null when git cannot be run. Unreadable is not a version. */
  async version(): Promise<string | null> {
    return output(await this.exec(['--version']));
  }

  /** The tracked ref as git reports it (`origin/main`), or null when none is set. */
  async upstreamRef(): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']));
  }

  /** Remote names, in the order git lists them. */
  async remotes(): Promise<string[]> {
    return lines(await this.exec(['remote']));
  }

  /** Remote names, in the order git lists them. A failed read is an error, not "none". */
  /**
   * The URL `git push <remote>` uses, as the pre-push hook receives it: pushurl, then
   * pushInsteadOf and insteadOf applied by git itself. The first, when there are several.
   */
  async remotePushUrl(remote: string): Promise<string | null> {
    return output(await this.exec(['remote', 'get-url', '--push', remote]));
  }

  /**
   * A bare URL after git's insteadOf rewriting (`ls-remote --get-url` contacts nothing).
   * It reads fetch rules, so a pushInsteadOf on a bare push URL is not applied.
   */
  async rewrittenUrl(url: string): Promise<string | null> {
    if (url.startsWith('-')) return null;
    return output(await this.exec(['ls-remote', '--get-url', url]));
  }

  async readRemotes(): Promise<Result<string[]>> {
    const listed = await this.exec(['remote']);
    if (!succeeded(listed)) return err(listed.stderr.trim() || 'git remote failed');
    return ok(lines(listed));
  }

  /** Whether any ref exists under `refs/remotes/<remote>/`. A failed read is an error, not "none". */
  async hasTrackingRefs(remote: string): Promise<Result<boolean>> {
    const listed = await this.exec(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/' + remote + '/']);
    if (!succeeded(listed)) return err(listed.stderr.trim() || 'git for-each-ref failed');
    return ok(lines(listed).length > 0);
  }

  /**
   * The directory every worktree shares -- where hooks and config actually live.
   * In a linked worktree `.git` is a FILE, so joining '.git' to the root gives a
   * path that cannot be written to. `--git-common-dir` is the only right answer.
   */
  async commonDir(): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--git-common-dir']));
  }

  /**
   * The directory git will actually run hooks from: `core.hooksPath` when it is
   * set (husky and friends set it), otherwise the common dir's `hooks`. May be
   * relative to `cwd`, like commonDir(). NOT `--path-format=absolute`: that needs
   * git 2.31, and older git echoes the unknown flag back and exits 0, which
   * would turn the answer into a path nobody runs hooks from.
   */
  async hooksDir(): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--git-path', 'hooks']));
  }

  // ---- config -------------------------------------------------------------

  private scoped(scope: ConfigScope | undefined, args: readonly string[]): string[] {
    return scope ? ['config', `--${scope}`, ...args] : ['config', ...args];
  }

  /** The value, or null when unset. Omit `scope` to read what git would EFFECTIVELY use. */
  async getConfig(key: string, scope?: ConfigScope): Promise<string | null> {
    return output(await this.exec(this.scoped(scope, ['--get', key])));
  }

  /** Effective boolean, or null when unset or not a bool. Omit `scope` for any-scope. */
  async getBoolConfig(key: string, scope?: ConfigScope): Promise<boolean | null> {
    const value = output(await this.exec(this.scoped(scope, ['--type=bool', '--get', key])));
    return value === 'true' ? true : value === 'false' ? false : null;
  }

  async getAllConfig(key: string, scope?: ConfigScope): Promise<string[]> {
    return lines(await this.exec(this.scoped(scope, ['--get-all', key])));
  }

  /**
   * Every value of a multi-valued key, INCLUDING empty ones.
   *
   * `getAllConfig` drops blanks, which is right for a list of owners or branches
   * and wrong here. An empty `credential.<url>.helper` is not noise: it is the
   * list reset that discards every helper configured before it, and so it is the
   * single most important line to show someone asking why their credentials
   * stopped working. Filtering it out made `repown fix` preview two values while
   * removing four, and hid the one the explanation is actually about.
   */
  async getAllConfigRaw(key: string, scope?: ConfigScope): Promise<string[]> {
    const result = await this.exec(this.scoped(scope, ['--get-all', key]));
    if (!succeeded(result)) return [];
    // git ends every value with LF on every platform, so a CR is part of a value: kept.
    const split = result.stdout.split('\n');
    // git terminates the last value with a newline, so a trailing empty element
    // is an artefact of splitting -- unlike any earlier one, which is a value.
    if (split[split.length - 1] === '') split.pop();
    return split;
  }

  async setConfig(key: string, value: string, scope: ConfigScope = 'local'): Promise<boolean> {
    return succeeded(await this.exec(this.scoped(scope, [key, value])));
  }

  /** Appends one more value to a multi-valued key. */
  async addConfig(key: string, value: string, scope: ConfigScope): Promise<boolean> {
    return succeeded(await this.exec(this.scoped(scope, ['--add', key, value])));
  }

  /** True when the key is gone afterwards -- including when it was never set. */
  async unsetConfig(key: string, scope: ConfigScope = 'local'): Promise<boolean> {
    const result = await this.exec(this.scoped(scope, ['--unset-all', key]));
    return succeeded(result) || result.code === 5; // 5 = the key did not exist
  }

  /**
   * What git would really use for `url`, honouring the credential.<pattern> rules.
   *
   * THIS IS THE ONLY CORRECT WAY TO READ A CREDENTIAL HELPER. An empty
   * `credential.<url>.helper` value is defined by gitcredentials(7) as RESETTING
   * the list, discarding every helper configured before it. Collecting entries by
   * hand and taking the last -- or worse, the first -- gets the wrong answer on
   * exactly the machine this tool exists to diagnose.
   */
  async getUrlMatch(key: string, url: string): Promise<string | null> {
    return output(await this.exec(['config', '--get-urlmatch', key, url]));
  }

  /** Which FILE each matching key lives in, so a repair edits the scope that holds it. */
  async configOrigins(pattern: string, scope?: ConfigScope): Promise<ConfigEntry[]> {
    const args = this.scoped(scope, ['--show-origin', '--get-regexp', pattern]);
    return lines(await this.exec(args)).flatMap(parseOriginLine);
  }

  // ---- history ------------------------------------------------------------

  /**
   * Author and committer of every commit in `range`, which is passed to git as
   * separate arguments so a caller can use `<sha> --not --remotes=origin`.
   */
  async identitiesIn(range: readonly string[]): Promise<Result<CommitIdentity[]>> {
    const [log, count] = await Promise.all([
      this.exec(['log', '--no-show-signature', `--format=${IDENTITY_FORMAT}`, ...range]),
      this.exec(['rev-list', '--count', ...range]),
    ]);
    // An empty list would read as "no foreign commits": a failure must stay one.
    if (!succeeded(log)) return err(log.timedOut ? 'git log timed out reading the range' : log.stderr.trim() || 'git log failed');
    const commits = parseIdentities(log.stdout);
    // The author writes the subject and the name. Whatever they contain, every
    // commit in the range must come back parsed, or the answer is not trusted.
    if (!commits.ok) return commits;
    if (!succeeded(count) || Number(count.stdout.trim()) !== commits.value.length) {
      return err('could not account for every commit in the range');
    }
    return commits;
  }

  /**
   * The tagger address of every annotated tag in the chain starting at `sha`
   * (a tag may point at a tag). Empty when `sha` is not a tag at all. `git log`
   * peels tags to their commit, so this is the only place a tagger is seen.
   */
  async taggersOf(sha: string): Promise<Result<string[]>> {
    const taggers: string[] = [];
    for (let object = sha, depth = 0; depth < MAX_TAG_CHAIN; depth++) {
      const type = await this.exec(['cat-file', '-t', object]);
      // A missing starting object is the range check's to refuse; only a broken chain is ours.
      if (!succeeded(type)) return depth === 0 ? ok(taggers) : err('could not read object ' + object);
      if (type.stdout.trim() !== 'tag') return ok(taggers);
      const body = await this.exec(['cat-file', 'tag', object]);
      const next = /^object ([0-9a-f]+)$/m.exec(body.stdout)?.[1];
      if (!succeeded(body) || !next) return err('could not read tag ' + object);
      const tagger = /^tagger [^<\n]*<([^>\n]*)>/m.exec(body.stdout)?.[1];
      taggers.push(tagger ?? '');                        // no tagger line: '' never matches
      object = next;
    }
    return err('tag chain longer than ' + MAX_TAG_CHAIN + ' starting at ' + sha);
  }

  // ---- rewriting (repown reauthor only) -------------------------------------

  /** A long or networked call: its own environment and timeout. Still only exec.ts spawns. */
  private execLong(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ExecResult> {
    return run('git', ['--no-replace-objects', ...args], { cwd: this.cwd, env, timeoutMs });
  }

  /** Fetch with every prompt off: a sign-in that would ask fails instead. The reason is cleaned for display. */
  async fetchQuietly(remote: string): Promise<Result<void>> {
    const fetched = await this.execLong([...QUIET, 'fetch', '--quiet', '--no-recurse-submodules', remote], await this.quietEnvHere(), NETWORK_MS);
    return succeeded(fetched) ? ok(undefined) : err(networkReason(fetched));
  }

  /** How many branches the remote lists (network, prompts off). */
  async remoteHeadCount(remote: string): Promise<Result<number>> {
    const listed = await this.execLong([...QUIET, 'ls-remote', '--heads', remote], await this.quietEnvHere(), NETWORK_MS);
    return succeeded(listed) ? ok(lines(listed).length) : err(networkReason(listed));
  }

  /** Prompts off. ssh gets BatchMode only where neither the shell nor this clone names an ssh command. */
  private async quietEnvHere(): Promise<NodeJS.ProcessEnv> {
    return quietEnv(process.env, await this.getConfig('core.sshCommand') !== null);
  }

  /**
   * `git rebase <base> --exec <cmd>`, without moving other branches' refs, without folding
   * commits (autosquash), and with no hook at all: hooksPath names a directory that does not
   * exist, and `-c` reaches the --exec child too, so its `git commit` runs none either.
   */
  async rebaseExec(base: string, exec: string): Promise<Result<void>> {
    const noHooks = join(tmpdir(), 'repown-no-hooks-' + randomUUID());
    const off = ['-c', 'rebase.updateRefs=false', '-c', 'rebase.autoSquash=false', '-c', 'core.hooksPath=' + noHooks];
    const args = [...off, 'rebase', '--quiet', base, '--exec', exec];
    const rebased = await this.execLong(args, process.env, REBASE_MS);
    return succeeded(rebased) ? ok(undefined) : err(rebased.timedOut ? 'timed out' : networkReason(rebased));
  }

  async abortRebase(): Promise<boolean> {
    return succeeded(await this.exec(['rebase', '--abort']));
  }

  /** Creates `ref` at `sha`; refuses when it exists already, so nothing is overwritten. */
  async createRef(ref: string, sha: string): Promise<boolean> {
    return succeeded(await this.exec(['update-ref', ref, sha, '']));
  }

  /** Full hash of `rev`, or null when it does not resolve. */
  async revParse(rev: string): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--verify', '--quiet', rev + '^{commit}']));
  }

  /** Full hash of the first parent; null for a root commit. */
  async parentOf(sha: string): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--verify', '--quiet', sha + '^']));
  }

  async countIn(range: readonly string[]): Promise<Result<number>> {
    const counted = await this.exec(['rev-list', '--count', ...range]);
    const count = Number(counted.stdout.trim());
    return succeeded(counted) && Number.isInteger(count) ? ok(count) : err(counted.stderr.trim() || 'git rev-list failed');
  }

  /** Tracked changes, or entries hidden with skip-worktree / assume-unchanged, that a rebase could clobber. */
  async hasTrackedChanges(): Promise<Result<boolean>> {
    const [status, files] = await Promise.all([
      this.exec(['status', '--porcelain', '--untracked-files=no']), this.exec(['ls-files', '-v']),
    ]);
    if (!succeeded(status) || !succeeded(files)) return err('git status failed');
    const hidden = lines(files).some((line) => /^([a-z]|S) /.test(line));
    return ok(status.stdout.trim().length > 0 || hidden);
  }

  /** The operation a half-finished rebase, merge, cherry-pick, revert or bisect left, or null. */
  async operationInProgress(): Promise<string | null> {
    for (const [path, name] of IN_PROGRESS) {
      const where = output(await this.exec(['rev-parse', '--git-path', path]));
      if (where && existsSync(resolve(this.cwd, where))) return name;
    }
    return null;
  }

  /** `git rev-list --left-right --count A...B`: commits only on the left, and only on the right. */
  async leftRightCount(range: string): Promise<Result<{ left: number; right: number }>> {
    const counted = await this.exec(['rev-list', '--left-right', '--count', range]);
    const [left, right] = (succeeded(counted) ? counted.stdout.trim() : '').split(/\s+/).map(Number);
    if (!succeeded(counted) || !Number.isInteger(left) || !Number.isInteger(right)) {
      return err(counted.stderr.trim() || 'git rev-list could not count ' + range);
    }
    return ok({ left: left!, right: right! });
  }

  /** Each commit in `range` (full hash) and its first parent's short hash, null for a root. */
  async firstParentsIn(range: readonly string[]): Promise<Result<Map<string, string | null>>> {
    const listed = await this.exec(['log', '--no-show-signature', '--format=%H %p', ...range]);
    if (!succeeded(listed)) return err(listed.stderr.trim() || 'git log failed');
    return ok(new Map(lines(listed).map(parentPair)));
  }

  /** Whether this clone has the commit at all -- a remote tip it never fetched is absent. */
  async hasCommit(sha: string): Promise<boolean> {
    return succeeded(await this.exec(['cat-file', '-e', sha + '^{commit}']));
  }

  /**
   * Author/committer addresses across every ref, with a count each.
   *
   * `exclude` drops commits reachable from another ref, which is how a fork gets
   * a useful answer: counting every address in a mirror of someone else's
   * project reports that project's contributors and says nothing about this
   * clone. Excluding the mirror branch leaves the commits written HERE.
   */
  async emailCounts(exclude?: string): Promise<Result<Map<string, number>>> {
    // repown reauthor's backups keep the old commits alive; they are not this clone's history.
    const all = ['--exclude=refs/repown/*', '--all'];
    const range = exclude ? [...all, '--not', exclude] : all;
    // --no-show-signature: a scanned repository's own log.showSignature + gpg.program
    // would otherwise run a program of its choosing.
    const result = await this.exec(['log', '--no-show-signature', ...range, '--format=%ae%n%ce']);
    // An empty map would read as "no identities in history": a failure stays one.
    if (!succeeded(result)) return err(result.stderr.trim() || 'git log failed');
    const counts = new Map<string, number>();
    for (const address of lines(result)) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    return ok(counts);
  }
}

/**
 * `file:<path>\t<key> <value>`. The path is printed UNQUOTED and may hold
 * spaces (`C:/Program Files/Git/etc/gitconfig`), so it ends at the TAB, not at
 * the first space.
 */
function parseOriginLine(line: string): ConfigEntry[] {
  const match = /^file:([^\t]+)\t(\S+)(?: (.*))?$/.exec(line);
  if (!match) return [];
  return [{ file: match[1]!, key: match[2]!, value: match[3] ?? '' }];
}

/**
 * NUL-terminated fields, subject LAST. git refuses NUL in a name or an address,
 * so nothing an author writes can shift them; the subject cannot reach past its
 * own terminator either. Records are a fixed IDENTITY_FIELDS long.
 */
const NETWORK_MS = 120_000;
const REBASE_MS = 600_000;
/** Empty askPass: git asks no helper for a password (GIT_TERMINAL_PROMPT covers the terminal). */
const QUIET = ['-c', 'core.askPass=', '-c', 'credential.interactive=false'];
const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect'],
];

/**
 * The whole environment, with every way git could prompt turned off. ssh is made
 * non-interactive only where nothing names an ssh command already: GIT_SSH_COMMAND outranks
 * core.sshCommand and GIT_SSH, so setting it would replace a per-account key (`ssh -i ...`).
 */
export function quietEnv(env: NodeJS.ProcessEnv, sshConfigured: boolean): NodeJS.ProcessEnv {
  const { GIT_ASKPASS: _git, SSH_ASKPASS: _ssh, ...rest } = env;
  const ownSsh = sshConfigured || !!env['GIT_SSH_COMMAND'] || !!env['GIT_SSH'];
  const batch = ownSsh ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  return { ...rest, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...batch };
}

/** git's last error line, with a URL's credentials and query masked and control characters removed. */
export function networkReason(result: ExecResult): string {
  if (result.timedOut) return 'timed out';
  const last = result.stderr.trim().split('\n').filter(Boolean).at(-1) ?? 'git failed';
  return last.replace(/(\w+:\/\/)\S*@/g, '$1***@').replace(/(\w+:\/\/[^\s?]*)\?[^\s'"]*/g, '$1?***').replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

/** `<sha> <parent> [<parent>...]`; a root has none. */
function parentPair(line: string): [string, string | null] {
  const [sha = '', first = ''] = line.trim().split(' ');
  return [sha, first || null];
}

const IDENTITY_FORMAT = '%H%x00%ae%x00%ce%x00%an%x00%cn%x00%s%x00';
const IDENTITY_FIELDS = 6;
const MAX_TAG_CHAIN = 16;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function parseIdentities(stdout: string): Result<CommitIdentity[]> {
  const fields = stdout.split('\0');
  const commits: CommitIdentity[] = [];
  for (let at = 0; at + IDENTITY_FIELDS <= fields.length; at += IDENTITY_FIELDS) {
    const [sha, authorEmail, committerEmail, authorName, committerName, subject] =
      fields.slice(at, at + IDENTITY_FIELDS).map((field, index) => index === 0 ? field.trim() : field);
    if (!SHA.test(sha!)) return err('unreadable commit record from git log');
    commits.push({ sha: sha!, subject: subject!, authorName: authorName!, authorEmail: authorEmail!,
      committerName: committerName!, committerEmail: committerEmail! });
  }
  return ok(commits);
}
