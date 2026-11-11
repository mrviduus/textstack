// Debounced saves for the reader page (page.mjs `persist`). `relocate` fires on every scroll, so a
// position save waits 400 ms — long enough for the book under it to be replaced.
//
// What the key and the payload are is decided when `save` is called, never when the timer fires: a
// timer that read the page's current book would address the save of book A to book B and overwrite
// B's stored data with A's (or, mid-open, with `null`). Replacing a book flushes what is still pending:
// A's last turn is written under A's key at once, before B is on screen (#1128 S5).
export function createSaveScheduler(post) {
  let timer = 0
  let pending = null
  return {
    save(key, json, delay = 0) {
      clearTimeout(timer)
      pending = { type: 'store', key, json }
      timer = setTimeout(() => { const m = pending; pending = null; post(m) }, delay)
    },
    flush() {
      clearTimeout(timer)
      const m = pending
      pending = null
      if (m) post(m)
    },
  }
}
