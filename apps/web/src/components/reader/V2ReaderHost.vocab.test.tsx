import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { v2ReaderSyncApi, type V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost } from './V2ReaderHost'

// #1270: which book the host hands the popups to save words with: the production route's server book, when the
// opened bytes are its file and the book's language reads (savesWords).

let props: { bookId?: string; bookTitle?: string; bookLanguage: string } | null = null
vi.mock('./V2ReaderPopups', () => ({
  V2ReaderPopups: (p: typeof props) => { props = p; return null },
}))

const SHA = 'a'.repeat(64)
const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }

afterEach(() => { cleanup(); vi.restoreAllMocks(); props = null })

async function open(opened: object, sync: V2SyncTarget | undefined = T, dev = false) {
  vi.spyOn(v2ReaderSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(v2ReaderSyncApi, 'annotations').mockResolvedValue([])
  const view = render(<V2ReaderHost book={null} dev={dev} />)
  const frame = (screen.getByTitle('V2 reader') as HTMLIFrameElement).contentWindow!
  vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  await fromPage({ type: 'ready' })
  view.rerender(<V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: T.name, sync }} dev={dev} />)
  await fromPage({ type: 'opened', title: 'Walden', book: { sha256: SHA, size: 8, name: `1/${T.name}` }, ...opened })
}

describe('V2ReaderHost vocabulary book', () => {
  it('theServerBook_ItsIdAndTitle', async () => {
    await open({ lang: 'de' })
    expect(props).toMatchObject({ bookId: 'b1', bookTitle: 'Walden', bookLanguage: 'de' })
  })

  it('noLanguage_SavedUnderTheFallback', async () => {
    await open({})
    expect(props).toMatchObject({ bookId: 'b1', bookLanguage: 'en' })
  })

  it('aLanguageThatDoesNotRead_NothingSaved_TheFallbackForDisplayOnly', async () => {
    await open({ lang: 'deu' })
    expect(props).toMatchObject({ bookLanguage: 'en' })
    expect(props!.bookId).toBeUndefined()
  })

  it('bytesThatAreNotTheServerFile_NothingSaved', async () => {
    await open({ book: { sha256: 'b'.repeat(64), size: 8, name: `1/${T.name}` } })
    expect(props!.bookId).toBeUndefined()
  })

  it('theDevRoute_NothingSaved', async () => {
    await open({}, undefined, true)
    expect(props!.bookId).toBeUndefined()
  })
})
