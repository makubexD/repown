// Parsing a git remote URL into the pieces a host provider needs.
//
// Done by hand rather than with `new URL()` because the scp-like form
// `git@host:owner/repo` is not a URL and `new URL()` rejects it, while it is
// still one of the two forms every host documents.
//
// The userinfo is kept SEPARATE from the host, and that separation is the point:
// the guard this replaces substring-matched the whole URL, so
// `https://octocat@github.com/SomeoneElse/repo` passed the ownership check on
// the userinfo alone while pushing somewhere else entirely.

export interface GitUrl {
  readonly raw: string;
  readonly scheme: string;
  /** The `user` of user@host, never conflated with the host itself. */
  readonly user: string | null;
  readonly host: string;
  /** Path with no leading slash and no trailing `.git`. */
  readonly path: string;
  readonly segments: readonly string[];
}

export function parseGitUrl(raw: string): GitUrl | null {
  const text = raw.trim();
  if (!text || isFilesystemPath(text)) return null;
  return parseSchemed(text) ?? parseScpLike(text);
}

/**
 * A local path is not a URL, and must not be coerced into one.
 *
 * `C:/Users/me/remote.git` matches the scp-like shape exactly -- host `C`, path
 * `/Users/me/remote.git` -- so without this it parsed as a remote owned by
 * "Users". That is not a cosmetic slip: the guard compares the destination owner
 * against the pinned account, so a fabricated owner means refusing a legitimate
 * push to a local remote. Returning null instead leaves such a remote with no
 * host and no owner, which is the truth, and the destination check correctly
 * declines to have an opinion about it.
 */
const SEPARATOR = '[\\\\/]';

function isFilesystemPath(text: string): boolean {
  return new RegExp('^[A-Za-z]:' + SEPARATOR).test(text)   // C:/... and C:\...
      || new RegExp('^' + SEPARATOR).test(text)            // /abs/path and \\unc\share
      || new RegExp('^\\.\\.?' + SEPARATOR).test(text);    // ./rel and ../rel
}

function parseSchemed(text: string): GitUrl | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?\/(.*)$/.exec(text);
  if (!match) return null;
  return build(text, match[1]!.toLowerCase(), match[2] ?? null, match[3]!, match[4]!);
}

function parseScpLike(text: string): GitUrl | null {
  const match = /^(?:([^@/]+)@)?([^/:]+):(.+)$/.exec(text);
  if (!match) return null;
  return build(text, 'ssh', match[1] ?? null, match[2]!, match[3]!);
}

function build(
  raw: string,
  scheme: string,
  user: string | null,
  host: string,
  rawPath: string,
): GitUrl {
  const path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = path.split('/').filter((s) => s.length > 0).map(decodeSegment);
  return { raw, scheme, user, host: host.toLowerCase(), path, segments };
}

// Azure DevOps organisation and project names may contain spaces, which arrive
// percent-encoded (`Some%20Long%20Project%20Name`). Comparing an encoded segment
// against a plain name never matches.
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The scheme+host prefix git uses to key credential config, e.g. `https://github.com`. */
export function credentialPrefix(url: GitUrl): string {
  return `${url.scheme}://${url.host}`;
}
