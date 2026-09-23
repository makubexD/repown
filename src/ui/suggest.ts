// "Did you mean X?" for a mistyped command, action or option.
//
// Only ever offers a hint when exactly one candidate is close enough to be
// worth guessing -- a tie, or nothing within the threshold, gets no hint
// rather than a wrong one.

export function suggest(input: string, candidates: readonly string[]): string | null {
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(input, candidate) }))
    .filter((entry) => entry.distance > 0 && entry.distance <= threshold(input))
    .sort((a, b) => a.distance - b.distance);

  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[1]!.distance === ranked[0]!.distance) return null;
  return ranked[0]!.candidate;
}

function threshold(input: string): number {
  return input.length <= 4 ? 1 : 2;
}

function levenshtein(a: string, b: string): number {
  const dist: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dist[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) dist[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i]![j] = Math.min(dist[i - 1]![j]! + 1, dist[i]![j - 1]! + 1, dist[i - 1]![j - 1]! + cost);
    }
  }
  return dist[a.length]![b.length]!;
}
