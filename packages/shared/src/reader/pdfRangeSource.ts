/** What the reader engine opens a PDF from (`ChapterDoc['pdf']`, reader-engine `api.ts`). */
export type PdfSource =
  | { data: ArrayBuffer }
  | { length: number; read(begin: number, end: number): Promise<Uint8Array> }

interface Deps {
  fetch?: typeof globalThis.fetch
  /** The host's auth, read per request: web `{ credentials: 'include' }`, mobile the bearer token of the moment. */
  init: () => RequestInit
  /** Refreshes the auth (web: the session cookie; mobile: a new token from RN); a throw = the session is gone. */
  refresh: () => Promise<unknown>
}

const PDF_AUTH = { code: 'pdf-auth' } as const

/**
 * The bytes of a PDF for the engine (ADR-025, Phase 5 answer 4a): a length probe (`Range: bytes=0-0` →
 * `Content-Range`), then `read(begin, end)` by ranges, each with the host's auth (`init`). A 401
 * refreshes and retries once inside the request, so the reader keeps their page; still denied →
 * `{ code: 'pdf-auth' }`. A server that ignores ranges (200) hands the whole file as `data`.
 * Web and mobile (inside the WebView) both use it.
 */
export async function openPdfSource(url: string, { fetch = globalThis.fetch, init, refresh }: Deps): Promise<PdfSource> {
  async function get(range: string): Promise<Response> {
    const once = () => {
      const i = init()
      return fetch(url, { ...i, headers: { ...(i.headers as Record<string, string> | undefined), Range: `bytes=${range}` } })
    }
    let r = await once()
    if (r.status === 401) {
      try { await refresh() } catch { throw PDF_AUTH }
      r = await once()
    }
    if (r.status === 401 || r.status === 403) throw PDF_AUTH
    if (!r.ok) throw new Error(`PDF ${url}: HTTP ${r.status}`)
    return r
  }

  const probe = await get('0-0')
  if (probe.status === 200) return { data: await probe.arrayBuffer() }
  const length = Number(probe.headers.get('Content-Range')?.split('/')[1])
  if (!Number.isFinite(length) || length <= 0) throw new Error(`PDF ${url}: no length in Content-Range`)
  return {
    length,
    async read(begin, end) {
      const r = await get(`${begin}-${end - 1}`)
      // A 200 here is the whole file, not the chunk: never hand it to pdf.js as one (→ 'pdf-load').
      if (r.status !== 206) throw new Error(`PDF ${url}: HTTP ${r.status} for a range`)
      return new Uint8Array(await r.arrayBuffer())
    },
  }
}
