import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readerSyncApi, type SyncTarget } from '../../lib/readerSync'
import { ReaderHost } from './ReaderHost'

// #1270: which book the host hands the popups to save words with: the production route's server book, when the
// opened bytes are its file and the book's language reads (savesWords).

let props: { bookId?: string; bookTitle?: string; bookLanguage: string; marksLanguage?: string | null } | null = null
vi.mock('./ReaderPopups', () => ({
  ReaderPopups: (p: typeof props) => { props = p; return null },
}))

const SHA = 'a'.repeat(64)
const T: SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }

afterEach(() => { cleanup(); vi.restoreAllMocks(); props = null })

async function open(opened: object, sync: SyncTarget | undefined = T, dev = false) {
  vi.spyOn(readerSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(readerSyncApi, 'annotations').mockResolvedValue([])
  const view = render(<ReaderHost book={null} dev={dev} />)
  const frame = (screen.getByTitle('Book text') as HTMLIFrameElement).contentWindow!
  vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  await fromPage({ type: 'ready' })
  view.rerender(<ReaderHost book={{ bytes: new ArrayBuffer(8), name: T.name, sync }} dev={dev} />)
  await fromPage({ type: 'opened', title: 'Walden', book: { sha256: SHA, size: 8, name: `1/${T.name}` }, ...opened })
}

describe('ReaderHost vocabulary book', () => {
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

  // #1271 review: marks follow savesWords' rule: the language words are saved under, none where the book's does not read.
  it('marksLanguage_TheBooksReadableLanguage_ElseTheFallback_NoneWhenDeclaredButUnreadable', async () => {
    await open({ lang: 'de-AT' })
    expect(props!.marksLanguage).toBe('de')
    cleanup()
    await open({})
    expect(props!.marksLanguage).toBe('en')
    cleanup()
    await open({ lang: 'deu' })
    expect(props!.marksLanguage).toBeNull()
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
