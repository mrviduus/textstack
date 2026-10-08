/**
 * A background refresh may apply its answer only if nothing changed locally since it started.
 * The book screen's "In Library" is set optimistically by taps (Save, first download) and re-read
 * on focus; without this a refresh that left before the tap landed would flip the button back.
 */
export function createLocalChangeGuard() {
  let generation = 0
  return {
    /** A local change happened (optimistic state set). */
    touch: () => { generation++ },
    /** Start a refresh; keep the token. */
    begin: () => generation,
    /** Whether the refresh that got `token` may still apply. */
    mayApply: (token: number) => token === generation,
  }
}
