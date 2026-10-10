// A remote's fetch refspecs (`remote.<name>.fetch`), read the way git reads them: which
// tracking ref a branch gets, and where the remote's tracking refs live (ADR-025).
//
// A clone made with --single-branch fetches only its one branch, and a negative refspec
// (`^refs/heads/x`) leaves a branch out. A push of such a branch updates no tracking ref,
// so `HEAD --not --remotes` cannot see what that push published.

/** `HEAD --not --remotes` counts only these: a tracking ref anywhere else proves nothing. */
const REMOTES = 'refs/remotes/';

interface Refspec {
  readonly src: string;
  readonly dst: string | null;
  readonly negative: boolean;
}

/** The tracking ref the refspecs give `ref` (a full `refs/heads/...` name) under refs/remotes/, or null. */
export function trackingRefOf(specs: readonly string[], ref: string): string | null {
  const parsed = specs.map(parse);
  if (parsed.some((spec) => spec.negative && matched(spec.src, ref) !== null)) return null;
  for (const spec of parsed) {
    const middle = spec.negative || !spec.dst ? null : matched(spec.src, ref);
    const tracking = middle === null ? null : spec.dst!.replace('*', middle);
    if (tracking?.startsWith(REMOTES)) return tracking;
  }
  return null;
}

/** Where the refspecs write under refs/remotes/: the namespace before a glob's star, or the exact ref. */
export function trackingPrefixes(specs: readonly string[]): string[] {
  const written = specs.map(parse).flatMap((spec) => spec.negative || !spec.dst ? [] : [spec.dst.split('*')[0]!]);
  return written.filter((prefix) => prefix.startsWith(REMOTES));
}

function parse(raw: string): Refspec {
  const text = raw.trim().replace(/^\+/, '');
  if (text.startsWith('^')) return { src: text.slice(1), dst: null, negative: true };
  const colon = text.indexOf(':');
  if (colon < 0) return { src: text, dst: null, negative: false };
  return { src: text.slice(0, colon), dst: text.slice(colon + 1) || null, negative: false };
}

/** What the star stands for ('' for an exact match), or null when `ref` does not match. */
function matched(src: string, ref: string): string | null {
  const full = src.startsWith('refs/') ? src : 'refs/heads/' + src;
  const star = full.indexOf('*');
  if (star < 0) return full === ref ? '' : null;
  const [before, after] = [full.slice(0, star), full.slice(star + 1)];
  const fits = ref.length >= before.length + after.length && ref.startsWith(before) && ref.endsWith(after);
  return fits ? ref.slice(before.length, ref.length - after.length) : null;
}
