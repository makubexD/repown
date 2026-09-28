// Comparing a tool's reported major.minor.patch. gh's login gate and setup's
// push.autoSetupRemote gate share this, so the two comparisons cannot drift.

/** True when the captured major.minor.patch is at least `min`. A non-number fails. */
export function versionAtLeast(found: RegExpMatchArray, min: readonly [number, number, number]): boolean {
  for (let i = 0; i < min.length; i++) {
    const got = Number(found[i + 1]);
    if (got !== min[i]) return got > min[i]!;
  }
  return true;
}

/** Git gained `push.autoSetupRemote` in 2.37.0. Unreadable text is not that. */
const AUTO_UPSTREAM_MIN: readonly [number, number, number] = [2, 37, 0];

export function gitSupportsAutoUpstream(text: string): boolean {
  const found = /git version (\d+)\.(\d+)\.(\d+)/.exec(text);
  return found !== null && versionAtLeast(found, AUTO_UPSTREAM_MIN);
}
