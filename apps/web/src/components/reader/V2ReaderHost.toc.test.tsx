import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { V2ReaderHost, type V2HostBook } from './V2ReaderHost'

// #1261: the table of contents and the section controls of the V2 reader on the web, through a fake frame as
// V2ReaderHost.chrome.test.tsx.

const frame = () => screen.getByTitle('V2 reader') as HTMLIFrameElement
let posted: { call: string; args: unknown[] }[]

beforeEach(() => {
  localStorage.clear()
  posted = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

const host = (book: V2HostBook) => <MemoryRouter><V2ReaderHost book={book} idleHeading="idle" /></MemoryRouter>

function fromPage(m: object) {
  act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame().contentWindow })) })
}

const TOC = [
  { label: 'Part One', href: 'p1.xhtml', depth: 0 },
  { label: 'The Pond', href: 'c1.xhtml', depth: 1 },
  { label: 'The Woods', href: 'c2.xhtml#woods', depth: 1 },
  { label: 'Part Two', href: 'p2.xhtml', depth: 0 },
]

/** A book open on screen with `toc`, the reader at `tocIndex` (none: no relocate yet). */
function opened(toc: unknown, tocIndex?: number | null) {
  const view = render(host({ bytes: new ArrayBuffer(8), name: 'a.epub' }))
  vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
  fromPage({ type: 'ready' })
  fromPage({ type: 'opened', title: 'Walden', toc, book: { sha256: 'aa', size: 8, name: '1/a.epub' } })
  if (tocIndex !== undefined) fromPage(relocate(tocIndex))
  posted = []
  return view
}
const relocate = (tocIndex: unknown, moved = false) => ({ type: 'relocate', fraction: 0.4, index: 1, sections: 4, toc: 'x', tocIndex, moved })
const contents = () => screen.queryByRole('button', { name: 'Contents' })
/** As a real click does: the button takes focus, then opens the dialog. */
const openDrawer = () => act(() => {
  contents()!.focus()
  fireEvent.click(contents()!)
})
const dialog = () => screen.queryByRole('dialog', { name: 'Contents' })
const entries = () => within(dialog()!).getAllByRole('button').filter((b) => b.hasAttribute('data-depth'))
const current = () => entries().filter((b) => b.getAttribute('aria-current') === 'true').map((b) => b.textContent)
const goTos = () => posted.filter((m) => m.call === 'goTo').map((m) => m.args)
const bars = () => document.querySelector('main')!.getAttribute('data-bars')

describe('V2ReaderHost table of contents', () => {
  it('contents_BookWithAToc_OpensADialogOfNestedEntriesWithTheCurrentOneMarkedAndFocused', () => {
    opened(TOC, 2)
    expect(dialog()).toBeNull()
    openDrawer()
    expect(dialog()!.getAttribute('aria-modal')).toBe('true')
    expect(entries().map((b) => [b.textContent, b.getAttribute('data-depth')])).toEqual([['Part One', '0'], ['The Pond', '1'], ['The Woods', '1'], ['Part Two', '0']])
    expect(entries()[1].style.paddingLeft).not.toBe(entries()[0].style.paddingLeft)
    expect(current()).toEqual(['The Woods'])
    expect(document.activeElement).toBe(entries()[2])
  })

  it('contents_NoRelocateYet_NothingMarkedAndFocusOnClose', () => {
    opened(TOC)
    openDrawer()
    expect(current()).toEqual([])
    expect(document.activeElement).toBe(within(dialog()!).getByRole('button', { name: 'Close contents' }))
  })

  it('entry_Chosen_GoesToItsHrefAsTheReadersChoice_ClosesAndGivesFocusBack', () => {
    opened(TOC, 0)
    openDrawer()
    act(() => { fireEvent.click(entries()[2]) })
    expect(goTos()).toEqual([['c2.xhtml#woods', true]])
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(contents())
  })

  it('entry_Chosen_ItsRelocateKeepsTheBars', () => {
    opened(TOC, 0)
    openDrawer()
    act(() => { fireEvent.click(entries()[3]) })
    fromPage(relocate(3, true))
    expect(bars()).toBe('shown')
  })

  it.each([
    ['no toc', undefined],
    ['an empty toc', []],
    ['a toc of malformed entries', [null, { label: 'x' }, { href: 'x.xhtml' }, 'c1.xhtml']],
    ['a toc that is no list', 'c1.xhtml'],
  ])('contents_%s_NoButtonAndNoSectionControls', (_name, toc) => {
    opened(toc, 0)
    expect(contents()).toBeNull()
    expect(screen.queryByTestId('v2-prev-section')).toBeNull()
    expect(screen.queryByTestId('v2-next-section')).toBeNull()
    // The page turns stay.
    expect(screen.getByRole('button', { name: 'Next ›' })).toBeTruthy()
  })

  it('current_RepeatedLabelsAndADroppedEntry_MarkedByThePagesIndex', () => {
    opened([{ label: 'Notes', href: 'a.xhtml', depth: 0 }, { label: '', href: 'gone.xhtml', depth: 0 }, { label: 'Notes', href: 'b.xhtml', depth: 0 }, { label: 'Notes', href: 'c.xhtml', depth: 0 }], 2)
    openDrawer()
    expect(entries().map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true', null])
    act(() => { fireEvent.click(entries()[1]) })
    expect(goTos()).toEqual([['b.xhtml', true]])
  })

  it.each([[99], [-1], ['2'], [1.5], [null]])('current_TocIndex%s_NothingMarked', (tocIndex) => {
    opened(TOC, tocIndex as never)
    openDrawer()
    expect(current()).toEqual([])
  })

  it('current_FollowsTheLatestRelocate', () => {
    opened(TOC, 0)
    fromPage(relocate(3))
    openDrawer()
    expect(current()).toEqual(['Part Two'])
  })

  it('dialog_Escape_Closes_AndItsKeysNeverTurnThePage', () => {
    opened(TOC, 1)
    openDrawer()
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', ' ']) act(() => { fireEvent.keyDown(document.activeElement!, { key }) })
    expect(posted).toEqual([])
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(contents())
  })

  it('dialog_TabOnTheLastEntry_WrapsToTheCloseButton', () => {
    opened(TOC, 3)
    openDrawer()
    expect(document.activeElement).toBe(entries()[3])
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Tab' }) })
    expect(document.activeElement).toBe(within(dialog()!).getByRole('button', { name: 'Close contents' }))
  })

  it('dialog_BackdropOrClose_Closes', () => {
    opened(TOC, 1)
    openDrawer()
    act(() => { fireEvent.click(document.querySelector('.reader-drawer-backdrop')!) })
    expect(dialog()).toBeNull()
    openDrawer()
    act(() => { fireEvent.click(within(dialog()!).getByRole('button', { name: 'Close contents' })) })
    expect(dialog()).toBeNull()
    expect(goTos()).toEqual([])
  })

  it('newOpen_TheContentsOfTheBookBeforeGo', () => {
    const view = opened(TOC, 1)
    openDrawer()
    view.rerender(host({ bytes: new ArrayBuffer(8), name: 'b.epub' }))
    // Opening: no book on screen, so no contents of the one before.
    expect(dialog()).toBeNull()
    expect(contents()).toBeNull()
    expect(screen.queryByTestId('v2-next-section')).toBeNull()
    fromPage({ type: 'opened', title: 'Other', toc: [{ label: 'Only', href: 'o.xhtml', depth: 0 }], book: { sha256: 'bb', size: 8, name: '2/b.epub' } })
    expect(dialog()).toBeNull()
    // The place of the book before is not this one's: the first entry is ahead until its own relocate.
    expect(screen.queryByTestId('v2-prev-section')).toBeNull()
    expect(screen.getByTestId('v2-next-section').textContent).toBe('Only ›')
  })
})

describe('V2ReaderHost place in the contents', () => {
  const status = () => screen.getByTestId('v2-status').textContent
  const A = { type: 'opened', title: 'Walden', toc: TOC, book: { sha256: 'aa', size: 8, name: '1/a.epub' } }

  /** As the page does it: a book's first relocate comes before its `opened`, and a fixed-layout book sends no other. */
  function openedAfterItsRelocate(tocIndex: number) {
    const view = render(host({ bytes: new ArrayBuffer(8), name: 'a.epub' }))
    vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
    fromPage({ type: 'ready' })
    fromPage(relocate(tocIndex))
    fromPage(A)
    posted = []
    return view
  }

  it('current_TheRelocateBeforeOpened_IsThisBooksPlace', () => {
    openedAfterItsRelocate(2)
    expect(screen.getByTestId('v2-prev-section').textContent).toBe('‹ The Pond')
    expect(screen.getByTestId('v2-next-section').textContent).toBe('Part Two ›')
    openDrawer()
    expect(current()).toEqual(['The Woods'])
  })

  it('current_ABookKeptAfterAFailedOpen_ItsOwnListAndPlace', () => {
    const view = render(host({ bytes: new ArrayBuffer(8), name: 'a.epub' }))
    vi.spyOn(frame().contentWindow!, 'postMessage').mockImplementation(((m: { call: string; args: unknown[] }) => { posted.push(m) }) as never)
    fromPage({ type: 'ready' })
    // A newer open starts before the first book answered; the page still shows the first one, which then answers.
    view.rerender(host({ bytes: new ArrayBuffer(8), name: 'b.epub' }))
    fromPage(relocate(2))
    fromPage(A)
    expect(contents()).toBeNull()
    fromPage({ type: 'open-failed', name: '2/b.epub', error: 'not a book' })
    // The failed open cleared the position: no title without its percent.
    expect(status()).toBe('')
    openDrawer()
    expect(entries().map((b) => b.textContent)).toEqual(['Part One', 'The Pond', 'The Woods', 'Part Two'])
    expect(current()).toEqual(['The Woods'])
  })

  it('chosenEntry_NoRelocateFollows_IsTheCurrentOneAtOnce_UntilARelocateSaysOtherwise', () => {
    opened(TOC, 0)
    // The section control: a jump within the view on screen may send no relocate.
    act(() => { fireEvent.click(screen.getByTestId('v2-next-section')) })
    expect(screen.getByTestId('v2-prev-section').textContent).toBe('‹ Part One')
    expect(screen.getByTestId('v2-next-section').textContent).toBe('The Woods ›')
    expect(status()).toBe('40% · The Pond')
    // The dialog.
    openDrawer()
    expect(current()).toEqual(['The Pond'])
    act(() => { fireEvent.click(entries()[3]) })
    openDrawer()
    expect(current()).toEqual(['Part Two'])
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }) })
    expect(goTos()).toEqual([['c1.xhtml', true], ['p2.xhtml', true]])
    fromPage(relocate(2))
    expect(status()).toBe('40% · The Woods')
  })

  it('sections_NeighboursOnTheCurrentHref_GoToAnotherPlace', () => {
    opened([{ label: 'Preface', href: 'pre.xhtml', depth: 0 }, { label: 'Part I', href: 'ch1.xhtml', depth: 0 }, { label: 'Chapter 1', href: 'ch1.xhtml', depth: 1 }, { label: 'Chapter 2', href: 'ch2.xhtml', depth: 1 }], 2)
    expect(screen.getByTestId('v2-prev-section').textContent).toBe('‹ Preface')
    expect(screen.getByTestId('v2-next-section').textContent).toBe('Chapter 2 ›')
  })

  it('status_ThePercentAndTheCurrentEntrysTitle_NeverASectionNumber', () => {
    opened(TOC, 2)
    // The resolved entry's label, not the relocate's raw one ('x'); no "section 2/4".
    expect(status()).toBe('40% · The Woods')
    fromPage({ ...relocate(3), fraction: 0.416, index: 3 })
    expect(status()).toBe('42% · Part Two')
  })

  it.each([['no entry yet', TOC, null], ['an index past the list', TOC, 99], ['a book with no contents', [], 1]])('status_%s_ThePercentAlone', (_name, toc, tocIndex) => {
    opened(toc, tocIndex)
    expect(status()).toBe('40%')
  })

  it('status_BeforeAnyRelocate_Empty', () => {
    opened(TOC)
    expect(status()).toBe('')
  })
})

describe('V2ReaderHost section controls', () => {
  const prev = () => screen.queryByTestId('v2-prev-section')
  const next = () => screen.queryByTestId('v2-next-section')

  it('sections_InTheMiddle_NamedByTitleNeverByNumber_AndGoThereAsTheReadersChoice', () => {
    opened(TOC, 1)
    expect(prev()!.textContent).toBe('‹ Part One')
    expect(next()!.textContent).toBe('The Woods ›')
    expect(prev()!.getAttribute('aria-label')).toBe('Previous section: Part One')
    expect(next()!.getAttribute('aria-label')).toBe('Next section: The Woods')
    expect(`${prev()!.textContent}${next()!.textContent}${prev()!.getAttribute('aria-label')}${next()!.getAttribute('aria-label')}`).not.toMatch(/\d/)
    act(() => { fireEvent.click(next()!) })
    // The chosen entry is the place at once: the one before it is now The Pond.
    act(() => { fireEvent.click(prev()!) })
    expect(goTos()).toEqual([['c2.xhtml#woods', true], ['c1.xhtml', true]])
  })

  it('sections_AtTheEnds_OnlyTheOneThatExists', () => {
    opened(TOC, 0)
    expect(prev()).toBeNull()
    expect(next()!.textContent).toBe('The Pond ›')
    fromPage(relocate(3))
    expect(prev()!.textContent).toBe('‹ The Woods')
    expect(next()).toBeNull()
  })

  it('sections_BeforeTheFirstEntry_TheFirstIsNext', () => {
    opened(TOC, null)
    expect(prev()).toBeNull()
    expect(next()!.textContent).toBe('Part One ›')
  })

  it('sections_AMove_KeepsTheBars', () => {
    opened(TOC, 1)
    act(() => { fireEvent.click(next()!) })
    fromPage(relocate(2, true))
    expect(bars()).toBe('shown')
    expect(next()!.textContent).toBe('Part Two ›')
  })
})
