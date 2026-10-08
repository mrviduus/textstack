/**
 * LIB-1: Download adds the book to the Library; cancelling a download that added it takes it back
 * out; a book saved by hand stays. "Added by download" is remembered only when the Library state was
 * known to be not-in-library and the add succeeded — never remove what we are not sure we added.
 */
export function downloadLibraryLink() {
  let added: Promise<boolean> | null = null
  return {
    start(state: 'in' | 'out' | 'unknown', add: () => Promise<boolean>) {
      if (state === 'in') return
      const p = add()
      if (state === 'out') added = p
    },
    /** Waits for the in-flight add first, so the DELETE never overtakes its POST. */
    async cancel(remove: () => unknown) {
      const p = added
      added = null
      if (p && await p) await remove()
    },
    /** A hand Save/remove makes the Library state the reader's own. */
    forget() { added = null },
  }
}
