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

export class Git {
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /**
   * --no-replace-objects on every call: `git replace` changes what git SHOWS for
   * an object, never what a push SENDS, so a replaced foreign commit read as the
   * clean replacement while the original was published.
   */
  private exec(args: readonly string[], input?: string): Promise<ExecResult> {
    const full = ['--no-replace-objects', ...args];
    return input === undefined
      ? run('git', full, { cwd: this.cwd })
      : run('git', full, { cwd: this.cwd, input });
  }

  // ---- location -----------------------------------------------------------

  async isRepo(): Promise<boolean> {
    return succeeded(await this.exec(['rev-parse', '--git-dir']));
  }

  /** The working tree root. Asked of git so a linked worktree resolves to itself. */
  async root(): Promise<string | null> {
    return output(await this.exec(['rev-parse', '--show-toplevel']));
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
    const split = result.stdout.split(/\r?\n/);
    // git terminates the last value with a newline, so a trailing empty element
    // is an artefact of splitting -- unlike any earlier one, which is a value.
    if (split[split.length - 1] === '') split.pop();
    return split;
  }

  async setConfig(key: string, value: string, scope: ConfigScope = 'local'): Promise<boolean> {
    return succeeded(await this.exec(this.scoped(scope, [key, value])));
  }

  /** True when the key is gone afterwards -- including when it was never set. */
  /** Appends one more value to a multi-valued key. */
  async addConfig(key: string, value: string, scope: ConfigScope): Promise<boolean> {
    return succeeded(await this.exec(this.scoped(scope, ['--add', key, value])));
  }

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
    const range = exclude ? ['--all', '--not', exclude] : ['--all'];
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
