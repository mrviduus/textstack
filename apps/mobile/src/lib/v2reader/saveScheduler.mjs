// Debounced saves for the reader page (page.mjs `persist`). `relocate` fires on every scroll, so a
// position save waits 400 ms — long enough for the book under it to be replaced.
//
// What the key and the payload are is decided when `save` is called, never when the timer fires: a
// timer that read the page's current book would address the save of book A to book B and overwrite
// B's stored data with A's (or, mid-open, with `null`). Opening a book cancels what is still pending.
export function createSaveScheduler(post) {
  let timer = 0
  return {
    save(key, json, delay = 0) {
      clearTimeout(timer)
      timer = setTimeout(() => post({ type: 'store', key, json }), delay)
    },
    cancel() {
      clearTimeout(timer)
    },
  }
}
