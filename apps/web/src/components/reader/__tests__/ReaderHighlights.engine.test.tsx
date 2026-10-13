import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react'
import { createRef } from 'react'
import type { EngineEvents, Locator, ReaderEngine } from '@textstack/reader-engine'

// Phase 4 slice 3: with the engine on, the reader's popups take the engine's events — selection
// (hold, drag, a desktop double-click) → WordPopup / SelectionToolbar, imageTap → lightbox,
// linkClick → footnote jump / new tab — and the old DOM listeners stay off (gap 8). Slice 4: the engine
// draws highlights (+ the reviewed dot), saved words and search hits; the old overlay layers stay off.
vi.mock('../../../lib/readerEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/readerEngine')>()),
  READER_ENGINE: true,
}))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../../../context/NativeLanguageContext', () => ({
  useNativeLanguage: () => ({ nativeLanguage: 'uk', setNativeLanguage: vi.fn(), hasConfirmedLanguage: true }),
}))
vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ openAuthModal: vi.fn() }) }))
const addWord = vi.fn((..._a: unknown[]) => Promise.resolve({ outcome: 'saved' }))
let vocabMap = new Map<string, { stage: number; translation?: string }>()
vi.mock('../../../hooks/useReaderVocabulary', () => ({
  useReaderVocabulary: () => ({
    vocabMap, addWord: (...a: unknown[]) => addWord(...a), removeWord: vi.fn(), updateTranslation: vi.fn(),
    replaceTranslation: vi.fn(), recordSavedWord: vi.fn(), idbUnavailable: false, dismissIdbUnavailable: vi.fn(),
    guestNudge: null, dismissGuestNudge: vi.fn(),
  }),
}))
vi.mock('../../../hooks/useTts', () => ({
  useTts: () => ({ speak: vi.fn(), stop: vi.fn(), isPlaying: false, timestamps: [], currentWordIndex: -1 }),
}))
const translate = vi.fn()
vi.mock('../../../hooks/useTextTranslation', () => ({
  useTextTranslation: () => ({
    translatedText: null, isLoading: false, error: null, translate: (...a: unknown[]) => translate(...a), reset: vi.fn(),
    languages: [], sourceLang: 'en', targetLang: 'uk', setSourceLang: vi.fn(), setTargetLang: vi.fn(),
  }),
}))
const explain = vi.fn()
vi.mock('../../../hooks/useExplain', () => ({
  useExplain: () => ({ explanation: null, isLoading: false, error: null, explain: (...a: unknown[]) => explain(...a), reset: vi.fn() }),
}))
const fetchWordBubble = vi.fn()
vi.mock('../../../lib/wordBubbleFetch', () => ({ fetchWordBubble: (...a: unknown[]) => fetchWordBubble(...a) }))
// The old layers' palettes stay; their drawing must not run with the engine on.
vi.mock('../HighlightOverlayLayer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../HighlightOverlayLayer')>()),
  HighlightOverlayLayer: () => <i data-testid="old-highlight-layer" />,
}))
vi.mock('../VocabOverlayLayer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../VocabOverlayLayer')>()),
  VocabOverlayLayer: () => <i data-testid="old-vocab-layer" />,
}))

import { ReaderHighlights } from '../ReaderHighlights'
import { setMountedEngine, unmountEngine } from '../../../lib/readerEngine'
import { ReviewedMarksContext } from '../ReviewedMarks'
import type { StoredHighlight } from '../../../lib/offlineDb'
import type { ReviewedMark } from '@textstack/shared'

type Handler = (p: unknown) => void

/** The engine as the host sees it: events in, clearSelection out. */
function fakeEngine() {
  const handlers: Record<string, Handler[]> = {}
  const engine = {
    on: (e: string, cb: Handler) => {
      (handlers[e] ??= []).push(cb)
      return () => { handlers[e] = handlers[e].filter((h) => h !== cb) }
    },
    clearSelection: vi.fn(),
    decorate: vi.fn(),
    markWords: vi.fn(),
    find: vi.fn(() => []),
    goTo: vi.fn(async () => 'exact'),
  } as unknown as ReaderEngine & Record<'clearSelection' | 'decorate' | 'markWords' | 'find' | 'goTo', ReturnType<typeof vi.fn>>
  const emit = <K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) => act(() => { handlers[e]?.forEach((h) => h(p)) })
  return { engine, emit }
}

const SENTENCE = 'He pocketed the coins and walked out.'
function selected(text: string, source: 'hold' | 'drag' = 'drag'): EngineEvents['selection'] {
  const start = SENTENCE.indexOf(text)
  const locator: Locator = {
    href: 'ch-1', type: 'text/html', locations: { charOffset: start },
    text: { before: SENTENCE.slice(0, start), highlight: text, after: SENTENCE.slice(start + text.length) },
  }
  return { locator, text, sentence: SENTENCE, source, tooLong: false, rect: { x: 10, y: 20, width: 30, height: 10 } }
}

/** The word popup opens after the host's stabilisation window. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 250)) })

describe('ReaderHighlights with the engine', () => {
  let eng: ReturnType<typeof fakeEngine>
  const addHighlight = vi.fn(async () => ({}) as never)

  const containerRef = createRef<HTMLDivElement>()
  function renderReader(props: Partial<Parameters<typeof ReaderHighlights>[0]> = {}) {
    return render(renderReaderElement(props))
  }
  function renderReaderElement(props: Partial<Parameters<typeof ReaderHighlights>[0]> = {}) {
    return (
      <ReaderHighlights
        editionId="e1" chapterId="c1" containerRef={containerRef} engineOpenedFor="ch-1"
        highlights={[]} addHighlight={addHighlight} updateHighlight={vi.fn()} removeHighlight={vi.fn()}
        {...props}
      >
        <div ref={containerRef}>
          <article data-chapter-id="c1">
            <p>{SENTENCE} <img src="/fig.png" alt="fig" /> <a href="#fn1">1</a></p>
            <aside id="fn1">The note.</aside>
          </article>
        </div>
      </ReaderHighlights>
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vocabMap = new Map()
    eng = fakeEngine()
    setMountedEngine({ engine: eng.engine, href: 'ch-1' })
  })
  afterEach(() => {
    cleanup()
    unmountEngine(eng.engine)
    vi.restoreAllMocks()
  })

  it.each(['hold', 'drag'] as const)('engine_OneWord_%s_OpensTheWordPopupWithTheSentence', async (source) => {
    // 'drag' with one word is also the desktop double-click (gap 5: hold ignores the mouse).
    const { container } = renderReader()
    await eng.emit('selection', selected('pocketed', source))
    await settle()
    expect(container.querySelector('.word-popup__word')?.textContent).toBe('pocketed')
    expect(fetchWordBubble).toHaveBeenCalledWith(expect.objectContaining({ word: 'pocketed', sentence: SENTENCE }))
    expect(addWord).toHaveBeenCalledWith(expect.objectContaining({ word: 'pocketed', sentence: SENTENCE }))
  })

  it('engine_WordPopupClosed_ClearsTheEngineSelection', async () => {
    renderReader()
    await eng.emit('selection', selected('pocketed', 'hold'))
    await settle()
    fireEvent.click(screen.getByLabelText('reader.wordPopup.close'))
    await settle()   // the popup's exit animation
    expect(eng.engine.clearSelection).toHaveBeenCalled()
  })

  it('engine_SeveralWords_ShowTheToolbar_TranslateCarriesTheSentence', async () => {
    renderReader()
    await eng.emit('selection', selected('pocketed the coins'))
    fireEvent.click(screen.getByLabelText('reader.selectionToolbar.translate'))
    expect(translate).toHaveBeenCalledWith('pocketed the coins', undefined, undefined, expect.objectContaining({ sentence: SENTENCE }))
  })

  it('engine_SeveralWords_ExplainCarriesTheSentence', async () => {
    renderReader()
    await eng.emit('selection', selected('pocketed the coins'))
    fireEvent.click(screen.getByLabelText('reader.selectionToolbar.explain'))
    expect(explain).toHaveBeenCalledWith(expect.objectContaining({ word: 'pocketed the coins', sentence: SENTENCE }))
  })

  it('engine_Highlight_SavesTheSelectionsAnchor_AndClearsIt', async () => {
    renderReader()
    await eng.emit('selection', selected('pocketed the coins'))
    await act(async () => { fireEvent.click(screen.getByLabelText('reader.selectionToolbar.highlightYellow')) })
    const start = SENTENCE.indexOf('pocketed')
    expect(addHighlight).toHaveBeenCalledWith(
      { prefix: 'He ', exact: 'pocketed the coins', suffix: ' and walked out.', startOffset: start, endOffset: start + 18, chapterId: 'c1' },
      'yellow', 'pocketed the coins',
    )
    expect(eng.engine.clearSelection).toHaveBeenCalled()
  })

  it('engine_SelectionGone_HidesTheToolbar', async () => {
    renderReader()
    await eng.emit('selection', selected('pocketed the coins'))
    await eng.emit('selection', null)
    expect(screen.queryByLabelText('reader.selectionToolbar.translate')).toBeNull()
  })

  it('engine_NativeSelectionListenersOff', async () => {
    const { container } = renderReader()
    nativeSelect(container.querySelector('p')!)
    await settle()
    expect(screen.queryByLabelText('reader.selectionToolbar.translate')).toBeNull()
  })

  it('engine_OriginalPdf_KeepsTheNativeSelection', async () => {
    // Phase 5 moves the PDF onto the engine; until then its text layer selects natively.
    const { container } = renderReader({ liveActionsOnly: true, engineOpenedFor: null })
    nativeSelect(container.querySelector('p')!)
    await settle()
    expect(screen.getByLabelText('reader.selectionToolbar.translate')).toBeTruthy()
  })

  it('engine_ImageTap_OpensTheLightbox_TheOldClickDoesNot', async () => {
    const { container } = renderReader()
    fireEvent.click(container.querySelector('img')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    await eng.emit('imageTap', { src: 'https://x/fig.png', alt: 'fig', rect: { x: 0, y: 0, width: 1, height: 1 } })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog').querySelector('img')!.src).toBe('https://x/fig.png')
  })

  it('engine_FootnoteLink_JumpsToTheNote', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container } = renderReader()
    await eng.emit('linkClick', { href: '#fn1', internal: true })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('#fn1'))
    expect(open).not.toHaveBeenCalled()
  })

  it('engine_FootnoteLinkNamingItsOwnFile_JumpsToTheNote', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { container } = renderReader()
    await eng.emit('linkClick', { href: 'text00012.html#fn1', internal: true })
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('#fn1'))
  })

  it('engine_LinkWithAMalformedEscape_DoesNotThrow', async () => {
    renderReader()
    await eng.emit('linkClick', { href: '#100%', internal: true })   // a URIError here fails the test
  })

  it('engine_ExternalLink_OpensANewTab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderReader()
    await eng.emit('linkClick', { href: 'https://example.com/a', internal: false })
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener')
  })

  it.each([['other-file.xhtml#x', true], ['javascript:alert(1)', false], ['mailto:a@b.c', false]])(
    'engine_Link_%s_DoesNothing_814', async (href, internal) => {
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      renderReader()
      await eng.emit('linkClick', { href, internal })
      expect(open).not.toHaveBeenCalled()
      expect(scrollIntoView).not.toHaveBeenCalled()
    },
  )

  // --- Slice 4: decorations ---

  const START = SENTENCE.indexOf('pocketed the coins')
  const anchor = { prefix: 'He ', exact: 'pocketed the coins', suffix: ' and walked out.', startOffset: START, endOffset: START + 18, chapterId: 'c1' }
  const hl = (id: string, over: Partial<StoredHighlight> = {}) =>
    ({ id, editionId: 'e1', chapterId: 'c1', anchor, color: 'yellow', selectedText: anchor.exact, ...over }) as StoredHighlight
  const quoted = expect.objectContaining({ href: 'ch-1', text: { before: 'He ', highlight: 'pocketed the coins', after: ' and walked out.' } })
  const reviewedMarks = (id: string) => ({ marks: new Map([[id, {} as ReviewedMark]]), reviewPath: () => '' })

  it('engine_OldOverlayLayersOff', () => {
    renderReader({ highlights: [hl('h1')] })
    expect(screen.queryByTestId('old-highlight-layer')).toBeNull()
    expect(screen.queryByTestId('old-vocab-layer')).toBeNull()
  })

  it('engine_OriginalPdf_LeavesTheEngineAlone', () => {
    renderReader({ liveActionsOnly: true, engineOpenedFor: null, highlights: [hl('h1')] })
    expect(eng.engine.decorate).not.toHaveBeenCalled()
  })

  it('engine_Highlights_DrawnFromTheirAnchors_OnlyThisChapters_ReviewedOnesWithADot', () => {
    const other = hl('h2', { chapterId: 'c9', anchor: { ...anchor, chapterId: 'c9' } })
    const pdf = hl('h3', { anchor: { kind: 'pdf', page: 1, rects: [], exact: 'x' } as unknown as StoredHighlight['anchor'] })
    render(
      <ReviewedMarksContext.Provider value={reviewedMarks('h1')}>
        {renderReaderElement({ highlights: [hl('h1'), other, pdf, hl('h4', { color: 'green' })] })}
      </ReviewedMarksContext.Provider>,
    )
    expect(eng.engine.decorate.mock.calls.filter(([g]) => g === 'highlight').pop()).toEqual(['highlight', [
      { id: 'h1', locator: quoted, style: expect.stringContaining('hl-yellow') },
      { id: 'h1', locator: quoted, style: 'dot' },
      { id: 'h4', locator: quoted, style: expect.stringContaining('hl-green') },
    ]])
  })

  it('engine_HighlightTap_OpensTheNoteEditor_ASearchHitTapDoesNot', async () => {
    renderReader({ highlights: [hl('h1')] })
    await eng.emit('decorationTap', { group: 'search', id: '0', rect: { x: 1, y: 2, width: 3, height: 4 } })
    expect(screen.queryByLabelText('reader.noteEditor.close')).toBeNull()
    await eng.emit('decorationTap', { group: 'highlight', id: 'h1', rect: { x: 1, y: 2, width: 3, height: 4 } })
    expect(screen.getByLabelText('reader.noteEditor.close')).toBeTruthy()
  })

  it('engine_HighlightLink_GoesThereCentred_ThenReportsLanded', async () => {
    const done = vi.fn()
    let land!: (r: string) => void
    eng.engine.goTo.mockReturnValue(new Promise((r) => { land = r }))
    renderReader({ highlights: [hl('h1')], scrollToHighlightId: 'h1', highlightLinkReady: true, onHighlightLinkDone: done })
    expect(eng.engine.goTo).toHaveBeenCalledWith(quoted, { align: 'center' })
    expect(done).not.toHaveBeenCalled()   // the restore stays held until the reader is there (ADR-019)
    await act(async () => { land('exact') })
    expect(done).toHaveBeenCalledWith(true)
  })

  it.each(['superseded', 'start'])('engine_HighlightLink_GoToResolves_%s_ReportsNotLanded', async (result) => {
    const done = vi.fn()
    eng.engine.goTo.mockResolvedValue(result)
    renderReader({ highlights: [hl('h1')], scrollToHighlightId: 'h1', highlightLinkReady: true, onHighlightLinkDone: done })
    await act(async () => {})
    expect(done).toHaveBeenCalledWith(false)
  })

  it('engine_Vocab_MarkedByTheEngine_WithTranslationsWhenOn', () => {
    vocabMap = new Map([['coins', { stage: 1, translation: 'монети' }]])
    renderReader({ showInlineTranslations: true })
    expect(eng.engine.markWords).toHaveBeenLastCalledWith(
      [{ word: 'coins', style: expect.stringContaining('vocab-stage1'), translation: 'монети' }], true,
    )
  })

  it('engine_Search_PaintsEveryHit_TheCurrentOneStronger_AndCentresIt', () => {
    const at = (n: number): Locator => ({ href: 'ch-1', type: 'text/html', locations: { charOffset: n }, text: { highlight: 'co' } })
    eng.engine.find.mockReturnValue([0, 10, 20].map((n) => ({ locator: at(n), context: '' })))
    const { rerender } = renderReader({ searchQuery: ' co ', searchActiveIndex: 1 })
    expect(eng.engine.find).toHaveBeenCalledWith('co')
    const [group, items] = eng.engine.decorate.mock.calls.find(([g]) => g === 'search')!
    expect(group).toBe('search')
    expect(items.map((i: { id: string }) => i.id)).toEqual(['0', '1', '2'])
    expect(items[0].style).toBe(items[2].style)
    expect(items[1].style).not.toBe(items[0].style)
    expect(eng.engine.goTo).toHaveBeenLastCalledWith(at(10), { align: 'center' })

    rerender(renderReaderElement({ searchQuery: '' }))
    expect(eng.engine.decorate).toHaveBeenLastCalledWith('search', [])
  })
})

/** A native selection over the element's text, as a mouse drag leaves it (jsdom has no layout). */
function nativeSelect(el: Element) {
  const range = document.createRange()
  range.selectNodeContents(el.firstChild!)
  range.getClientRects = () => [new DOMRect(10, 20, 30, 10)] as unknown as DOMRectList
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  // jsdom hands back the same Range object from getRangeAt.
  fireEvent.mouseUp(document)
}
