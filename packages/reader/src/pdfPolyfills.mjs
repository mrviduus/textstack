// Runtime APIs the vendored pdf.js 5.5.207 (modern build) calls and an older Android System WebView lacks
// (#1128 S5 review). esbuild's `chrome90` target lowers syntax only, never APIs. Imported FIRST by the
// carried `pdf` reader (build.mjs FORMATS.pdf), so it runs before pdf.js, and only when a PDF opens.
// Each is installed only where missing; each is the few lines the spec needs for how pdf.js calls it.
// structuredClone (pdf.js's main-thread "worker" clones every message with it) is NOT polyfillable here:
// page.mjs refuses a PDF without it (`PDF_NEEDS`). Checked by formats.check.mjs ("old WebView").
const define = (o, k, v) => { if (o && !(k in o)) Object.defineProperty(o, k, { value: v, writable: true, configurable: true }) }

for (const M of [Map, WeakMap]) {
  define(M.prototype, 'getOrInsertComputed', function (key, make) {
    if (!this.has(key)) this.set(key, make(key))
    return this.get(key)
  })
  define(M.prototype, 'getOrInsert', function (key, value) {
    if (!this.has(key)) this.set(key, value)
    return this.get(key)
  })
}
define(Promise, 'withResolvers', function () {
  let resolve, reject
  const promise = new this((ok, no) => { resolve = ok; reject = no })
  return { promise, resolve, reject }
})
define(Promise, 'try', function (fn, ...args) { return new this((ok) => ok(fn(...args))) })
define(AbortSignal, 'any', (signals) => {
  const ac = new AbortController()
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true, signal: ac.signal })
  }
  return ac.signal
})
define(Array.prototype, 'at', function (i) { i = Math.trunc(i) || 0; return this[i < 0 ? this.length + i : i] })
define(String.prototype, 'at', function (i) { i = Math.trunc(i) || 0; return this.charAt(i < 0 ? this.length + i : i) || undefined })
define(Array.prototype, 'findLast', function (f, t) { for (let i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i] })
define(Uint8Array.prototype, 'toHex', function () { return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('') })
define(Uint8Array.prototype, 'toBase64', function () {
  let s = ''
  for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode(...this.subarray(i, i + 0x8000))
  return btoa(s)
})
define(Uint8Array, 'fromBase64', (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
define(ArrayBuffer.prototype, 'transferToFixedLength', function (length = this.byteLength) {
  const out = new Uint8Array(length)
  out.set(new Uint8Array(this, 0, Math.min(length, this.byteLength)))
  return out.buffer
})
define(URL, 'parse', (url, base) => { try { return new URL(url, base) } catch { return null } })
if (typeof ReadableStream !== 'undefined') {
  define(ReadableStream.prototype, Symbol.asyncIterator, async function* () {
    const reader = this.getReader()
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) return; yield value }
    } finally { reader.releaseLock() }
  })
}
