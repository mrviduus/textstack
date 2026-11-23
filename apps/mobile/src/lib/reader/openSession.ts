/**
 * The reading session open in a mounted reader (#1313), endable from outside it: sign-out ends it before its push
 * and loss check (#1322), else the reader's unmount ends it after the library is wiped. No native imports: no twin.
 */
let ender: (() => Promise<unknown>) | null = null

/** The reader's: how to end (and store) its open session. Returns the release, for the unmount. */
export function holdOpenSession(end: () => Promise<unknown>) {
  ender = end
  return () => { if (ender === end) ender = null }
}

/** Ends the open session, if any, once it is stored; nothing held resolves at once. */
export const endOpenSession = (): Promise<unknown> => ender?.() ?? Promise.resolve()
