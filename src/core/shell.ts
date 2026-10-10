// Commands printed for someone to copy and paste, quoted so every shell reads them the same
// (test/paste.test.ts runs each). Build any copyable word here, never by hand.

/**
 * A word of a command printed to copy, as sh, bash, dash, zsh, fish, PowerShell and cmd all
 * read it (test/paste.test.ts runs each). Bare when no shell treats any of it specially: a
 * leading `@` is a PowerShell splat, and PowerShell splits a dashed word at `.` or `:`.
 * `--` is quoted, since PowerShell drops a bare one from the `$args` of repown.ps1.
 * Otherwise double quotes, unless they would expand or end early somewhere: `$` and a
 * backtick (POSIX, PowerShell), `%` and `!` (cmd), a curly double quote (PowerShell), a
 * backslash that escapes (`\\`, or one before the closing quote), a control character, or
 * nothing at all (Windows PowerShell drops `""`). Then it is null and the caller prints no
 * command: single quotes are no quotes in cmd, and PowerShell would run the rest of a
 * POSIX `'\''` as code.
 */
export function shellWord(value: string): string | null {
  if (value === '--') return '"--"';
  if (/^(?:-[\w-]*|[\w./][\w.@+/:-]*)$/.test(value)) return value;
  if (value === '' || /["$`%!“”„\x00-\x1f\x7f-\x9f]|\\\\|\\$/.test(value)) return null;
  return '"' + value + '"';
}

/** A whole command to copy, or null when one of its words can't be printed safely (shellWord). */
export function copyableCommand(words: readonly string[]): string | null {
  const quoted = words.map(shellWord);
  return quoted.every((word) => word !== null) ? quoted.join(' ') : null;
}

/** A git positional (a remote name) as argv words: after `--` when git would read it as an option. */
export function positional(word: string): string[] {
  return word.startsWith('-') ? ['--', word] : [word];
}
