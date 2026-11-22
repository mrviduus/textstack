import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'
import type { V2SyncTarget } from '../../lib/v2ReaderSync'

// #1314: bookmarks on the web host. The button adds one at the place on screen or removes the one there (through the
// page), the Bookmarks tab lists them in the page's order and a tap jumps there. On the production route a bookmark is
// the book's annotation of colour `bookmark`: written by the session as a highlight is, tombstoned on removal.

const SHA = 'aa'
const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const FILE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const BOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const frame = () => screen.getByTitle('Book text') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]

const api = vi.hoisted(() => ({
  getReadingState: vi.fn(), pullAll: vi.fn(), putReadingState: vi.fn(), putAnnotation: vi.fn(), deleteAnnotation: vi.fn(),
}))
vi.mock('@textstack/shared', async (orig) => {
  const real = await orig<typeof import('@textstack/shared')>()
  return { ...real, syncApi: { ...real.syncApi, ...api } }
})

beforeEach(() => {
  localStorage.clear()
  posted = []
  for (const f of Object.values(api)) f.mockReset()
})
afterEach(cleanup)

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

function opened({ sync, annotatable = true, bookmarkable = annotatable, toc = [] as object[] }: { sync?: V2SyncTarget; annotatable?: boolean; bookmarkable?: boolean; toc?: object[] } = {}) {
  const book: V2HostBook = { bytes: new ArrayBuffer(8), name: 'a.epub', sync }
  const view = render(<MemoryRouter><V2ReaderHost book={book} idleHeading="idle" dev={!sync} /></MemoryRouter>)
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', lang: 'en', annotatable, bookmarkable, toc, book: { sha256: SHA, size: 8, name: '1/a.epub' } })
  posted = []
  return view
}
const item = (id: string, text: string, n = 2) => ({ id, cfi: `epubcfi(/6/${n}!/4/2,/1:0,/1:5)`, text, at: 1 })
const list = (bookmarks: object[], here: string | null = null, can = true, key = SHA, placing = false) => fromPage({ type: 'bookmark-list', key, bookmarks, here, can, placing })
const calls = (name: string) => posted.filter((m) => m.call === name).map((m) => m.args)
const button = () => screen.queryByTestId('v2-bookmark')
const openTab = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
  fireEvent.click(screen.getByTestId('v2-bookmarks-tab'))
  return screen.getByTestId('v2-bookmarks-list')
}
/** The rows' jump buttons (each row has a remove button too). */
const rows = (ul: HTMLElement) => within(ul).getAllByTestId('v2-bookmark-row')

describe('V2ReaderHost bookmarks', () => {
  it('button_NoneHere_AddsOneThroughThePage', () => {
    opened()
    // On the bars at once, disabled until the page says what is here (the bars never shift under the pointer).
    expect(button()).toBeDisabled()
    list([])
    expect(button()).toBeEnabled()
    // One name whatever its state (a toggle's label never changes); the state is aria-pressed.
    expect(button()).toHaveAttribute('aria-label', 'Bookmark')
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button()!)
    expect(posted.filter((m) => /Bookmark/.test(m.call))).toEqual([{ call: 'addBookmark', args: [] }])
  })

  it('button_OneHere_RemovesThatOneThroughThePage', () => {
    opened()
    list([item(ID1, 'elsewhere', 2), item(ID2, 'on this screen', 4)], ID2)
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(button()!)
    expect(posted.filter((m) => /Bookmark/.test(m.call))).toEqual([{ call: 'removeBookmark', args: [ID2] }])
  })

  it('button_NothingToBookmarkHere_Disabled_ButOneHereCanStillBeRemoved', () => {
    opened()
    list([], null, false)
    expect(button()).toBeDisabled()
    fireEvent.click(button()!)
    expect(posted.filter((m) => /Bookmark/.test(m.call))).toEqual([])
    list([item(ID1, 'kept')], ID1, false)
    expect(button()).toBeEnabled()
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    expect(button()).toHaveAttribute('aria-pressed', 'true')
  })

  it('button_ABookWithoutAnnotations_NotOffered_NoTab', () => {
    // (Whatever the page says of bookmarks: where the host offers no annotations it writes none.)
    opened({ annotatable: false, bookmarkable: true, toc: [{ label: 'One', href: 'a.xhtml', depth: 0 }] })
    list([], null, true)
    expect(button()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    expect(screen.queryByTestId('v2-bookmarks-tab')).toBeNull()
  })

  it('list_InThePagesOrder_TapJumpsThereAsTheReadersChoice', () => {
    opened()
    list([item(ID2, 'first in the book', 2), item(ID1, 'later', 6)])
    const ul = openTab()
    expect(rows(ul).map((b) => b.textContent)).toEqual(['first in the book', 'later'])
    expect(ul).not.toHaveTextContent('No bookmarks yet')
    expect(screen.getByTestId('v2-bookmarks-tab')).toHaveTextContent('Bookmarks (2)')
    fireEvent.click(within(ul).getByText('later'))
    // Chosen: the page saves where it lands.
    expect(calls('goTo')).toEqual([[item(ID1, 'later', 6).cfi, true]])
    expect(screen.queryByTestId('v2-bookmarks-list')).toBeNull()
  })

  it('list_Empty_StillBeingPlaced_SaysLoading_NeverThatThisPageTakesNone', () => {
    opened()
    // The page has not said yet, then says bookmarks are still being placed: loading, whatever `can` is.
    expect(openTab()).toHaveTextContent('Bookmarks are loading…')
    list([], null, false, SHA, true)
    expect(screen.getByTestId('v2-bookmarks-list')).toHaveTextContent('Bookmarks are loading…')
    expect(screen.getByTestId('v2-bookmarks-list')).not.toHaveTextContent('This page cannot be bookmarked')
  })

  it('list_Empty_SaysHowToAddOne_OrThatThisPageTakesNone', () => {
    opened()
    list([])
    expect(openTab()).toHaveTextContent('No bookmarks yet. Add one to come back to a place.')
    // An image-only screen of a book with text: the page says none can be made here.
    list([], null, false)
    expect(screen.getByTestId('v2-bookmarks-list')).toHaveTextContent('No bookmarks yet. This page cannot be bookmarked.')
  })

  it('row_ItsRemoveButton_NamedByTheBookmarksWords_RemovesThatOneThroughThePage_TheListStaysOpen', () => {
    opened()
    // Neither is the one here: a bookmark further down the screen, or anywhere else in the book.
    list([item(ID2, 'first in the book', 2), item(ID1, 'later', 6)])
    const ul = openTab()
    fireEvent.click(within(ul).getByRole('button', { name: 'Remove bookmark: later' }))
    expect(posted.filter((m) => /Bookmark|goTo/.test(m.call))).toEqual([{ call: 'removeBookmark', args: [ID1] }])
    expect(screen.getByTestId('v2-bookmarks-list')).toBeInTheDocument()
  })

  it('tab_ABookThatTakesNoBookmark_NoTab_UnlessItHoldsSome', () => {
    // A pre-paginated EPUB: highlights are offered, a bookmark can be made nowhere.
    opened({ bookmarkable: false, toc: [{ label: 'One', href: 'a.xhtml', depth: 0 }] })
    list([], null, false)
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    expect(screen.getByTestId('v2-highlights-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('v2-bookmarks-tab')).toBeNull()
    // One it holds all the same (made elsewhere) is listed, and can be removed.
    list([item(ID1, 'kept')], null, false)
    fireEvent.click(screen.getByTestId('v2-bookmarks-tab'))
    expect(rows(screen.getByTestId('v2-bookmarks-list')).map((b) => b.textContent)).toEqual(['kept'])
  })

  it('list_AnotherBooksList_Dropped_AMalformedItemDropped_HereOfADroppedItemIsNone', () => {
    opened()
    list([item(ID2, 'kept'), { ...item(ID1, 'bad'), cfi: 'javascript:alert(1)' }], ID1)
    // A previous open's list, arriving late, replaces nothing.
    list([item(ID1, 'other book')], ID1, true, 'bb')
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(rows(openTab()).map((b) => b.textContent)).toEqual(['kept'])
  })

  it('list_UntrustedText_RenderedAsText', () => {
    opened()
    list([item(ID1, '<img src=x onerror=alert(1)>')])
    const ul = openTab()
    expect(ul).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(ul.querySelector('img')).toBeNull()
  })

  it('nextOpen_ThePreviousBooksBookmarksGo', () => {
    const view = opened()
    list([item(ID1, 'old book')], ID1)
    expect(button()).toHaveAttribute('aria-pressed', 'true')
    // Another book is opened: the one still on screen keeps no bookmark button of its own meanwhile.
    view.rerender(<MemoryRouter><V2ReaderHost book={{ bytes: new ArrayBuffer(8), name: 'b.epub' }} idleHeading="idle" dev /></MemoryRouter>)
    expect(button()).toBeNull()
    fromPage({ type: 'opened', title: 'Other', lang: 'en', annotatable: true, bookmarkable: true, toc: [], book: { sha256: 'cc', size: 8, name: '2/b.epub' } })
    // Until this open's own list comes: the button disabled and not pressed, the tab loading; the old book's late list
    // is not this one's.
    list([item(ID1, 'old book')], ID1)
    expect(button()).toBeDisabled()
    expect(button()).toHaveAttribute('aria-pressed', 'false')
    expect(openTab()).toHaveTextContent('Bookmarks are loading…')
    expect(within(screen.getByTestId('v2-bookmarks-list')).queryAllByTestId('v2-bookmark-row')).toHaveLength(0)
  })

  describe('production route (the session)', () => {
    const target: V2SyncTarget = { bookId: BOOK, fileId: FILE, format: 'epub', sha256: SHA, size: 8, name: 'a.epub' }
    const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:24)'
    const page = { id: ID1, cfi: CFI, index: 1, quote: 'It was a bright cold day', selectedText: 'It was a bright cold day', prefix: '', suffix: '', color: 'bookmark', at: 5 }
    const annotation = (extra: object = {}) => ({
      id: ID1, bookId: BOOK, fileId: FILE, selectedText: page.selectedText, noteText: null, color: 'bookmark',
      locator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: page.quote },
      createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z', deletedAt: null, revision: 1, ...extra,
    })
    const entry = (highlights: object[]) => JSON.stringify({ v: 1, book: { sha256: SHA, size: 8, name: '1/a.epub' }, position: null, highlights })

    async function openedSynced(annotations: object[] = []) {
      api.getReadingState.mockResolvedValue(null)
      api.pullAll.mockResolvedValue({ items: annotations })
      opened({ sync: target })
      await flush()
    }

    it('notOfferedUntilTheServersAnnotationsAreIn', async () => {
      api.getReadingState.mockResolvedValue(null)
      let landed!: (v: { items: object[] }) => void
      api.pullAll.mockReturnValue(new Promise((ok) => { landed = ok }))
      opened({ sync: target })
      await flush()
      list([])
      // A write before the pull could duplicate a bookmark the server holds.
      expect(button()).toBeNull()
      landed({ items: [] })
      await flush()
      expect(button()).toHaveAttribute('aria-pressed', 'false')
    })

    it('thePageIsToldMoreFollows_AndAlwaysGetsThem_AnEmptyPullToo_SoItSaysWhenOneCanBeMade', async () => {
      await openedSynced([])
      // `true`: annotations follow; the page makes no bookmark until `addHighlights` has placed them.
      expect(calls('restore').map((a) => a[1])).toEqual([true])
      expect(calls('addHighlights')).toEqual([[[]]])
      // The button follows the page's `can`, never the pull's timing: on the bars, disabled, then enabled.
      list([], null, false, SHA, true)
      expect(button()).toBeDisabled()
      list([], null, true)
      expect(button()).toBeEnabled()
      expect(button()).toHaveAttribute('aria-pressed', 'false')
    })

    it('theServersBookmark_GoesToThePageWithItsColour_AsTheOtherAnnotationsDo', async () => {
      await openedSynced([annotation(), annotation({ id: ID2, color: 'green' })])
      const [[sent]] = calls('addHighlights') as [{ id: string; color: string; cfi: string; selectedText: string }[]][]
      expect(sent.map((h) => [h.id, h.color, h.cfi, h.selectedText])).toEqual([[ID1, 'bookmark', CFI, page.selectedText], [ID2, 'green', CFI, page.selectedText]])
    })

    it('aNewBookmarkInTheStore_WrittenAsAnAnnotationOfColourBookmark', async () => {
      await openedSynced()
      api.putAnnotation.mockResolvedValue(annotation())
      fromPage({ type: 'store', key: SHA, json: entry([page]) })
      await flush()
      expect(api.putAnnotation.mock.calls).toEqual([[ID1, {
        expectedRevision: null, bookId: BOOK, fileId: FILE, selectedText: 'It was a bright cold day', noteText: null, color: 'bookmark',
        locator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'It was a bright cold day' },
      }]])
      // Held as written: the same entry again writes nothing.
      fromPage({ type: 'store', key: SHA, json: entry([page, { ...page, id: ID2, cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:3)' }]).replace(ID2, ID1).replace('epubcfi(/6/8!/4/2,/1:0,/1:3)', CFI) })
      await flush()
      expect(api.putAnnotation).toHaveBeenCalledTimes(1)
    })

    it('aRemovedBookmark_TombstonedOnTheServer_NeverWrittenAgain', async () => {
      await openedSynced([annotation()])
      api.deleteAnnotation.mockResolvedValue(annotation({ deletedAt: '2026-11-15T11:00:00Z', revision: 2 }))
      fromPage({ type: 'highlight-removed', key: SHA, id: ID1 })
      await flush()
      expect(api.deleteAnnotation.mock.calls).toEqual([[ID1]])
      // A store still carrying it (sent before the removal) does not bring it back.
      fromPage({ type: 'store', key: SHA, json: entry([page]) })
      await flush()
      expect(api.putAnnotation).not.toHaveBeenCalled()
    })

    it('aRemovalOfAnotherBook_NotTombstoned', async () => {
      await openedSynced([annotation()])
      fromPage({ type: 'highlight-removed', key: 'bb', id: ID1 })
      await flush()
      expect(api.deleteAnnotation).not.toHaveBeenCalled()
    })
  })
})
