// #1426: a book's details and cover, read from its file by the reader page before it is uploaded. The page parses
// untrusted books, so it runs in its own hidden frame (the reader's, sandboxed as V2ReaderHost's) and only what
// `readDescribed` takes comes back. Never throws and never blocks an upload past its deadline: null instead.
// ponytail: deep imports of apps/mobile source, as V2ReaderHost's.
import { V2_READER_FRAME_PATH } from '../../../../packages/reader/src/framePath.mjs'
import { readDescribed, type V2Described } from '../../../../packages/reader/src/describe.mjs'

/** How long the frame may take to load, parse the file and answer. */
export const DESCRIBE_MS = 20_000

/** The file's details and cover, or null (no answer in `deadlineMs`, not a book the page reads, any failure). */
export async function describeBook(file: Blob, deadlineMs = DESCRIBE_MS): Promise<V2Described | null> {
  const frame = document.createElement('iframe')
  let onMessage: ((e: MessageEvent) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const id = crypto.randomUUID()
    const answer = new Promise<V2Described | null>((done) => {
      timer = setTimeout(() => done(null), deadlineMs)
      onMessage = (e) => {
        if (e.source !== frame.contentWindow || e.origin !== location.origin || typeof e.data !== 'string') return
        let m: unknown
        try { m = JSON.parse(e.data) } catch { return }
        const type = (m as { type?: unknown } | null)?.type
        // The File itself: a Blob is cloned by reference, the bytes are not copied.
        if (type === 'ready') frame.contentWindow?.postMessage({ call: 'describeBytes', args: [file, id] }, location.origin)
        if (type !== 'described') return
        const d = readDescribed(m)
        if (d?.id === id) done(d.meta ? d : null)
      }
      addEventListener('message', onMessage)
    })
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    // Off screen, not display:none: the page lays out and draws the cover on a canvas.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    frame.src = V2_READER_FRAME_PATH
    document.body.append(frame)
    return await answer
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (onMessage) removeEventListener('message', onMessage)
    frame.remove()
  }
}
