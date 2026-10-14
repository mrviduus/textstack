import { openPdfSource as openWith, type PdfSource } from '@textstack/shared'

/** Web's PDF bytes for the engine: the shared range source (packages/shared) with the session cookie. */
export function openPdfSource(url: string, { refresh }: { refresh: () => Promise<unknown> }): Promise<PdfSource> {
  return openWith(url, { init: () => ({ credentials: 'include' }), refresh })
}
