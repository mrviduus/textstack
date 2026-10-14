import type { ChapterDoc } from '@textstack/reader-engine'

type PdfSource = NonNullable<ChapterDoc['pdf']>

interface Deps {
  fetch?: typeof globalThis.fetch
  /** Refreshes the session cookie (web: `refreshToken`); a throw = the session is gone. */
  refresh: () => Promise<unknown>
}

const PDF_AUTH = { code: 'pdf-auth' } as const

/**
 * The bytes of a PDF for the engine (ADR-025, Phase 5 answer 4a): the cookie (`credentials: 'include'`),
 * a length probe (`Range: bytes=0-0` → `Content-Range`), then `read(begin, end)` by ranges. A 401
 * refreshes the session and retries once inside the request, so the reader keeps their page; still
 * denied → `{ code: 'pdf-auth' }`. A server that ignores ranges (200) hands the whole file as `data`.
 */
export async function openPdfSource(url: string, { fetch = globalThis.fetch, refresh }: Deps): Promise<PdfSource> {
  async function get(range: string): Promise<Response> {
    const once = () => fetch(url, { credentials: 'include', headers: { Range: `bytes=${range}` } })
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
      return new Uint8Array(await (await get(`${begin}-${end - 1}`)).arrayBuffer())
    },
  }
}
