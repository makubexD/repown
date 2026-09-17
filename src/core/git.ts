// Everything this tool asks of git, in one place.
//
// Bound to a working directory rather than reading a global: every command runs
// against an explicit clone, `gid scan` walks seventeen of them in one process,
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

export type ConfigScope = 'local' | 'global' | 'system';

export interface Remote {
  readonly name: string;
  readonly url: string | null;
  readonly pushUrl: string | null;
}

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

const UNIT = '\x1f';
const RECORD = '\x1e';

export class Git {
  readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  private exec(args: readonly string[], input?: string): Promise<ExecResult> {
    return input === undefined
      ? run('git', args, { cwd: this.cwd })
      : run('git', args, { cwd: this.cwd, input });
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

  /** null when HEAD is detached, which callers must handle rather than assume. */
  async currentBranch(): Promise<string | null> {
    const branch = output(await this.exec(['rev-parse', '--abbrev-ref', 'HEAD']));
    return branch === 'HEAD' ? null : branch;
  }

  async hasCommits(): Promise<boolean> {
    return succeeded(await this.exec(['rev-parse', '--verify', '--quiet', 'HEAD']));
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
   * stopped working. Filtering it out made `gid fix` preview two values while
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

  // ---- remotes ------------------------------------------------------------

  async remotes(): Promise<Remote[]> {
    const names = lines(await this.exec(['remote']));
    return Promise.all(names.map((name) => this.remote(name)));
  }

  async remote(name: string): Promise<Remote> {
    const [url, pushUrl] = await Promise.all([
      this.getConfig(`remote.${name}.url`),
      this.getConfig(`remote.${name}.pushurl`),
    ]);
    return { name, url, pushUrl };
  }

  // ---- history ------------------------------------------------------------

  /**
   * Author and committer of every commit in `range`, which is passed to git as
   * separate arguments so a caller can use `<sha> --not --remotes=origin`.
   */
  async identitiesIn(range: readonly string[]): Promise<CommitIdentity[]> {
    const format = ['%H', '%s', '%an', '%ae', '%cn', '%ce'].join(UNIT) + RECORD;
    const result = await this.exec(['log', `--format=${format}`, ...range]);
    if (!succeeded(result)) return [];
    return result.stdout.split(RECORD).flatMap(parseIdentityRecord);
  }

  /**
   * Author/committer addresses across every ref, with a count each.
   *
   * `exclude` drops commits reachable from another ref, which is how a fork gets
   * a useful answer: counting every address in a mirror of someone else's
   * project reports that project's contributors and says nothing about this
   * clone. Excluding the mirror branch leaves the commits written HERE.
   */
  async emailCounts(exclude?: string): Promise<Map<string, number>> {
    const range = exclude ? ['--all', '--not', exclude] : ['--all'];
    const result = await this.exec(['log', ...range, '--format=%ae%n%ce']);
    const counts = new Map<string, number>();
    for (const address of lines(result)) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    return counts;
  }

  /** Does this object exist here? Used to tell a pushed commit from a local one. */
  async has(sha: string): Promise<boolean> {
    return succeeded(await this.exec(['cat-file', '-e', `${sha}^{commit}`]));
  }
}

function parseOriginLine(line: string): ConfigEntry[] {
  const match = /^file:(\S+)\s+(\S+)\s*(.*)$/.exec(line);
  if (!match) return [];
  return [{ file: match[1]!, key: match[2]!, value: match[3] ?? '' }];
}

function parseIdentityRecord(record: string): CommitIdentity[] {
  const fields = record.replace(/^\r?\n/, '').split(UNIT);
  if (fields.length < 6 || !fields[0]) return [];
  return [{
    sha: fields[0]!,
    subject: fields[1]!,
    authorName: fields[2]!,
    authorEmail: fields[3]!,
    committerName: fields[4]!,
    committerEmail: fields[5]!,
  }];
}
