/**
 * A background refresh may apply its answer only if nothing changed locally since it started and
 * no write is still in flight. The book screen's "In Library" is set optimistically by taps (Save,
 * download) and re-read on focus; without this a refresh would flip the button back under a tap,
 * or read the server before the tap's POST reached it.
 */
export function createLocalChangeGuard() {
  let generation = 0
  let pending = 0
  return {
    /** A local change happened (optimistic state set). */
    touch: () => { generation++ },
    /** Run a write (add/remove POST): refreshes are void while it runs and after it lands. */
    track: <T,>(write: Promise<T>): Promise<T> => {
      generation++
      pending++
      return write.finally(() => { pending--; generation++ })
    },
    /** Start a refresh; keep the token. */
    begin: () => generation,
    /** Whether the refresh that got `token` may still apply. */
    mayApply: (token: number) => pending === 0 && token === generation,
  }
}
