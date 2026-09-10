// Pure markdown-block helpers for the `Markdown` renderer. Kept RN-free so the block-detection
// rules are unit-testable under Vitest (see markdown.test.ts) without bundling React Native.

/**
 * True when `line` is a GFM table separator row (the `|---|:--:|` line under a header). A valid
 * separator MUST contain a pipe AND at least one dash — this is what distinguishes it from a bare
 * `---` thematic break, so a `---` following a pipe-containing paragraph is NOT mistaken for a table.
 */
export function isTableSeparator(line: string): boolean {
  return line.includes('|') && line.includes('-') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line)
}
