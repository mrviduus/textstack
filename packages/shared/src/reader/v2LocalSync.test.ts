import { describe, it, expect } from 'vitest'
import type { V2Annotation, V2ReadingState } from '../api/v2'
import {
  annotationHighlight, codePoints, decideServerState, highlightWrite, isUuid, ownAnnotationWrite, ownStateWrite,
  positionWrite, sameJson, spineIndexOf, statePosition, syncableText, type PageHighlight,
} from './v2LocalSync'
import { isPosition } from './v2PageStore'

const CFI = 'epubcfi(/6/14!/4/2/1:0)'
const pos = { cfi: CFI, quote: 'It was a bright cold day', index: 6, fraction: 0.41, at: Date.parse('2026-11-10T10:00:00Z') }
const state = (extra: Partial<V2ReadingState> = {}): V2ReadingState => ({
  bookId: 'b', fileId: 'f', currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'It was a bright cold day' },
  bookFraction: 0.41, frontierLocator: null, frontierFraction: null, completedAt: null,
  clientRecordedAt: '2026-11-10T11:00:00.000Z', updatedAt: '2026-11-10T11:00:01Z', revision: 3, resetRevision: null, ...extra,
})
const hl = (extra: Partial<PageHighlight> = {}): PageHighlight =>
  ({ id: '0b6a2c1e-1111-4222-8333-444455556666', cfi: CFI, index: 6, quote: 'bright', selectedText: 'bright cold', prefix: 'a ', suffix: ' day', color: 'yellow', at: 1, ...extra })

describe('v2LocalSync', () => {
  it('spineIndexOf_FoliateCfi_IndexFromFirstStep_OtherShapeNull', () => {
    expect(spineIndexOf(CFI)).toBe(6)
    expect(spineIndexOf('epubcfi(/6/2!/4)')).toBe(0)
    expect(spineIndexOf('epubcfi(/6/3!/4)')).toBeNull()
    expect(spineIndexOf('page:3')).toBeNull()
  })

  it('isUuid_ClientIdsBeforeAfter1078_OnlyUuidShapes', () => {
    expect(isUuid('0b6a2c1e-1111-4222-8333-444455556666')).toBe(true)
    expect(isUuid('lb_k3j2h1')).toBe(false)
    expect(isUuid('hlx9q2')).toBe(false)
  })

  it('codePoints_SurrogatePairAtTheCut_NeverSplit', () => {
    const s = `${'a'.repeat(63)}😀b`
    expect(codePoints(s, 64)).toBe(`${'a'.repeat(63)}😀`)
    expect(codePoints('😀xyz', 2, true)).toBe('yz')
  })

  it('positionWrite_QuotedPosition_EpubCfiWithQuoteAndClampedTime', () => {
    const w = positionWrite({ ...pos, at: Date.parse('2030-01-01T00:00:00Z') }, 'f', 4, Date.parse('2026-11-10T12:00:00Z'))
    expect(w).toEqual({
      expectedRevision: 4, fileId: 'f', bookFraction: 0.41, clientRecordedAt: '2026-11-10T12:00:00.000Z',
      currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'It was a bright cold day' },
    })
  })

  // #1188: a CBZ page is `page-name`, its entry name and section; never on another format, never by its CFI.
  const cbzPos = { cfi: 'epubcfi(/6/4)', page: 'Vol 1/p02.png', index: 1, fraction: 0.5, at: Date.parse('2026-11-10T10:00:00Z') }
  const pageState = (value: unknown, bookFraction = 0.5) =>
    state({ currentLocator: { version: 1, scheme: 'page-name', value } as V2ReadingState['currentLocator'], bookFraction })

  it('positionWrite_CbzPageOnACbz_PageNameWithEntryNameAndIndex', () => {
    expect(positionWrite(cbzPos, 'f', 3, Date.parse('2026-11-10T12:00:00Z'), 'cbz')).toEqual({
      expectedRevision: 3, fileId: 'f', bookFraction: 0.5, clientRecordedAt: '2026-11-10T10:00:00.000Z',
      currentLocator: { version: 1, scheme: 'page-name', value: { page: 'Vol 1/p02.png', index: 1 } },
    })
  })

  it('positionWrite_CbzPageOffACbz_Null', () => {
    // A fixed-layout EPUB's page (#1196) is not enabled: the server refuses page-name there.
    for (const format of ['epub', 'mobi', 'fb2', 'pdf', null]) expect(positionWrite(cbzPos, 'f', null, Date.now(), format), String(format)).toBeNull()
  })

  it('positionWrite_CbzPageTheServerWouldRefuse_Null', () => {
    for (const p of [
      { ...cbzPos, page: '' }, { ...cbzPos, page: '   ' }, { ...cbzPos, page: 'a'.repeat(513) }, { ...cbzPos, page: 'a\nb.png' },
      { ...cbzPos, page: 'a\u0085.png' }, { ...cbzPos, page: 'a\u007f.png' }, { ...cbzPos, page: 'a\ud800.png' }, { ...cbzPos, page: 'a\udc00.png' },
      { ...cbzPos, index: undefined }, { ...cbzPos, index: -1 }, { ...cbzPos, index: 1.5 }, { ...cbzPos, index: 2 ** 31 },
      { fraction: 0.5, at: 1 },
    ]) expect(positionWrite(p, 'f', null, Date.now(), 'cbz'), JSON.stringify(p)).toBeNull()
    // The edges that pass: 512 units, an astral character (a whole pair), the largest Int32 index.
    for (const p of [{ ...cbzPos, page: 'a'.repeat(512) }, { ...cbzPos, page: '😀.png' }, { ...cbzPos, index: 2 ** 31 - 1 }])
      expect(positionWrite(p, 'f', null, Date.now(), 'cbz')?.currentLocator.scheme, JSON.stringify(p)).toBe('page-name')
  })

  it('statePosition_PageName_RoundTripsAWriteAsThePagesImagePosition', () => {
    const w = positionWrite(cbzPos, 'f', null, Date.now(), 'cbz')!
    const back = statePosition(state({ currentLocator: w.currentLocator, bookFraction: w.bookFraction }), 'cbz')
    expect(back).toEqual({ cfi: 'epubcfi(/6/4)', page: 'Vol 1/p02.png', index: 1, fraction: 0.5, at: Date.parse('2026-11-10T11:00:00.000Z') })
    // The page store takes it (an image position: a CFI, the entry name, no quote), and its section is the CFI's.
    expect(isPosition(back)).toBe(true)
    expect(spineIndexOf(back!.cfi!)).toBe(1)
    expect(statePosition(pageState({ page: 'p01.png', index: 0 }), null)).toMatchObject({ cfi: 'epubcfi(/6/2)', page: 'p01.png', index: 0 })
  })

  it('statePosition_PageNameOffACbzOrMalformed_Null', () => {
    for (const format of ['epub', 'pdf', 'mobi']) expect(statePosition(pageState({ page: 'p01.png', index: 0 }), format), format).toBeNull()
    for (const value of [null, 'p01.png', {}, { page: 'p01.png' }, { index: 0 }, { page: '', index: 0 }, { page: 7, index: 0 }, { page: 'p', index: -1 }, { page: 'p', index: '0' }])
      expect(statePosition(pageState(value), 'cbz'), JSON.stringify(value)).toBeNull()
  })

  it('decideServerState_PageName_BySectionIndex', () => {
    const now = Date.parse('2026-11-10T12:00:00Z')
    const local = { ...cbzPos, at: Date.parse('2026-11-10T09:00:00Z') }
    const reader = { restoreApplied: true, moved: false, index: 1 }
    expect(decideServerState({ local, localFileId: 'f', server: pageState({ page: 'Vol 1/p02.png', index: 1 }), reader, format: 'cbz', now })).toBe('move')
    expect(decideServerState({ local, localFileId: 'f', server: pageState({ page: 'Vol 1/p09.png', index: 8 }), reader, format: 'cbz', now })).toBe('prompt')
    expect(decideServerState({ local, localFileId: 'f', server: pageState({ page: 'p', index: 8 }), reader, format: 'epub', now })).toBe('keep')
  })

  it('ownStateWrite_PageNameEchoedBack_IsOurs', () => {
    const w = positionWrite(cbzPos, 'f', null, Date.now(), 'cbz')!
    expect(ownStateWrite(state({ currentLocator: { ...w.currentLocator }, clientRecordedAt: w.clientRecordedAt }), w)).toBe(true)
  })

  it('statePosition_RoundTripsAPositionWrite_MalformedPdfPageNull', () => {
    expect(statePosition(state())).toMatchObject({ cfi: CFI, quote: pos.quote, index: 6, fraction: 0.41 })
    // pdf-page's value is `{"page":N}`, N a 1-based int (ADR-031): any other shape is no position, on a PDF too.
    for (const value of [3, { page: 0 }, { page: 1.5 }, { page: '3' }, null, {}])
      for (const format of [null, 'pdf'])
        expect(statePosition(state({ currentLocator: { version: 1, scheme: 'pdf-page', value } as V2ReadingState['currentLocator'] }), format), `${JSON.stringify(value)} ${format}`).toBeNull()
  })

  // #1128 S5: a PDF position is the page number, `pdf-page` on the wire, and nothing else.
  const pdfPos = { page: 12, index: 11, fraction: 0.3, at: Date.parse('2026-11-10T10:00:00Z') }
  const pdfState = (page: unknown = 7) => state({ currentLocator: { version: 1, scheme: 'pdf-page', value: { page } } as V2ReadingState['currentLocator'], bookFraction: 0.5 })

  it('positionWrite_PdfPageOnAPdf_PdfPageLocator', () => {
    expect(positionWrite(pdfPos, 'f', 2, Date.parse('2026-11-10T12:00:00Z'), 'pdf')).toEqual({
      expectedRevision: 2, fileId: 'f', bookFraction: 0.3, clientRecordedAt: '2026-11-10T10:00:00.000Z',
      currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 12 } },
    })
  })

  it('positionWrite_SchemeFitsTheFile_NeverPdfPageOffAPdf_NeverEpubCfiOnOne', () => {
    for (const format of ['epub', 'mobi', 'fb2', 'cbz', null]) expect(positionWrite(pdfPos, 'f', 2, Date.now(), format), String(format)).toBeNull()
    expect(positionWrite(pos, 'f', 2, Date.now(), 'pdf')).toBeNull()
    // The quoted position still writes epub-cfi on every other format, and with no format (the default).
    for (const format of ['epub', 'mobi', null]) expect(positionWrite(pos, 'f', 2, Date.now(), format)?.currentLocator.scheme, String(format)).toBe('epub-cfi')
  })

  it('positionWrite_NotAPdfPageOnAPdf_Null', () => {
    // A CBZ page (entry name beside a CFI), a page number beside a CFI or a quote, page 0, a fraction alone.
    for (const p of [
      { cfi: CFI, page: 'p1.jpg', index: 0, fraction: 0, at: 1 }, { cfi: CFI, page: 3, fraction: 0, at: 1 },
      { quote: 'q', page: 3, fraction: 0, at: 1 }, { page: 0, fraction: 0, at: 1 }, { page: 2.5, fraction: 0, at: 1 }, { fraction: 0.5, at: 1 },
    ]) expect(positionWrite(p, 'f', null, Date.now(), 'pdf'), JSON.stringify(p)).toBeNull()
  })

  it('statePosition_PdfPage_PageWithIndexPageMinusOne_RoundTripsAWrite', () => {
    const w = positionWrite({ page: 7, index: 6, fraction: 0.5, at: 1 }, 'f', null, Date.now(), 'pdf')!
    const at = Date.parse('2026-11-10T11:00:00.000Z')
    for (const format of ['pdf', null]) {
      expect(statePosition(state({ currentLocator: w.currentLocator, bookFraction: w.bookFraction }), format)).toEqual({ page: 7, index: 6, fraction: 0.5, at })
    }
  })

  it('statePosition_SchemeFitsTheFile_PdfPageOffAPdfNull_NothingButPdfPageOnAPdf', () => {
    for (const format of ['epub', 'mobi', 'cbz']) expect(statePosition(pdfState(), format), format).toBeNull()
    // On a PDF: no CFI, and no fraction fallback (#1187's allowlist is not for a PDF).
    expect(statePosition(state(), 'pdf')).toBeNull()
    expect(statePosition(state({ currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI } }), 'pdf')).toBeNull()
    for (const scheme of ['textstack-position-v1', 'textstack-anchor-v1'] as const) {
      const s = state({ currentLocator: { version: 1, scheme, value: { chapterSlug: 'x' } }, bookFraction: 0.7 })
      expect(statePosition(s, 'pdf'), scheme).toBeNull()
      expect(statePosition(s, 'epub'), scheme).toEqual({ fraction: 0.7, at: Date.parse('2026-11-10T11:00:00.000Z') })
    }
  })

  it('decideServerState_PdfPage_ByPageIndex_FractionOnAPdfKept', () => {
    const reader = { restoreApplied: true, moved: false, index: 6 }
    const local = { page: 7, index: 6, fraction: 0.4, at: Date.parse('2026-11-10T09:00:00Z') }
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(decideServerState({ local, localFileId: 'f', server: pdfState(7), reader, format: 'pdf', now })).toBe('move')
    expect(decideServerState({ local, localFileId: 'f', server: pdfState(9), reader, format: 'pdf', now })).toBe('prompt')
    expect(decideServerState({ local, localFileId: 'f', server: pdfState(9), reader: null, format: 'pdf', now })).toBe('adopt')
    const transitional = state({ currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x' } }, bookFraction: 0.7 })
    expect(decideServerState({ local, localFileId: 'f', server: transitional, reader: null, format: 'pdf', now })).toBe('keep')
  })

  it('decideServerState_PdfPage_NoLocalPosition_AdoptedOrByPage', () => {
    // #1128 S5 QA: a PDF never read here (no local position) takes the server's page; an open reader is
    // asked by page index, never by CFI.
    const now = Date.parse('2026-11-10T12:00:00Z')
    expect(decideServerState({ local: null, localFileId: 'f', server: pdfState(7), reader: null, format: 'pdf', now })).toBe('adopt')
    expect(decideServerState({ local: null, localFileId: 'f', server: pdfState(7), reader: { restoreApplied: true, moved: false, index: 6 }, format: 'pdf', now })).toBe('move')
    // Another file's state, or a pdf-page on a file this device reads as another format: kept.
    expect(decideServerState({ local: null, localFileId: 'g', server: pdfState(7), reader: null, format: 'pdf', now })).toBe('keep')
    expect(decideServerState({ local: null, localFileId: 'f', server: pdfState(7), reader: null, format: 'epub', now })).toBe('keep')
  })

  it('positionWrite_PdfPageAndCfiTogether_NeitherScheme', () => {
    // A position carrying both a page number and a CFI is no PDF position, and has no quote for epub-cfi.
    expect(positionWrite({ cfi: CFI, page: 3, index: 2, fraction: 0, at: 1 }, 'f', null, Date.now(), 'pdf')).toBeNull()
    expect(positionWrite({ cfi: CFI, page: 3, index: 2, fraction: 0, at: 1 }, 'f', null, Date.now(), 'epub')).toBeNull()
  })

  // QA #1128 S5 (fixed): the server reads `page` with TryGetInt32 (SyncValidation.IsPage): past 2^31-1 is no page.
  it('positionWrite_PageBeyondInt32_NotWritten', () => {
    expect(positionWrite({ page: 2 ** 31, index: 2 ** 31 - 1, fraction: 1, at: 1 }, 'f', null, Date.now(), 'pdf')).toBeNull()
    expect(positionWrite({ page: 2 ** 31 - 1, fraction: 1, at: 1 }, 'f', null, Date.now(), 'pdf')?.currentLocator.value).toEqual({ page: 2 ** 31 - 1 })
    expect(statePosition(pdfState(2 ** 31), 'pdf')).toBeNull()
  })

  it('statePosition_TransitionalScheme_FractionOnlyPosition', () => {
    // #1187: nobody converts a textstack-* locator to a CFI; the page resumes from bookFraction.
    const at = Date.parse('2026-11-10T11:00:00.000Z')
    for (const scheme of ['textstack-position-v1', 'textstack-anchor-v1'] as const) {
      expect(statePosition(state({ currentLocator: { version: 1, scheme, value: { chapterSlug: 'x' } }, bookFraction: 0.7 }))).toEqual({ fraction: 0.7, at })
    }
    // An epub-cfi without its quote cannot be verified at the CFI: by fraction too.
    expect(statePosition(state({ currentLocator: { version: 1, scheme: 'epub-cfi', value: CFI } }))).toEqual({ fraction: 0.41, at })
  })

  it('statePosition_TransitionalSchemeFractionOutOfRangeOrMissing_Null', () => {
    const other = { version: 1, scheme: 'textstack-position-v1', value: {} } as const
    for (const bookFraction of [-0.01, 1.5, NaN, null as unknown as number]) {
      expect(statePosition(state({ currentLocator: other, bookFraction })), String(bookFraction)).toBeNull()
    }
  })

  it('positionWrite_FractionOnlyPosition_NeverPushed', () => {
    // A position without a CFI is never sent as epub-cfi: the server's transitional locator stays.
    expect(positionWrite({ fraction: 0.7, at: 1 }, 'f', 3)).toBeNull()
    expect(positionWrite({ quote: 'q', fraction: 0.7, at: 1 }, 'f', 3)).toBeNull()
  })

  it('statePosition_UnknownSchemeWithAValidFraction_Null', () => {
    // An allowlist, not "anything but pdf-page": a scheme this build does not know is kept, as before #1187.
    const unknown = { version: 1, scheme: 'textstack-future-v9', value: {} } as unknown as V2ReadingState['currentLocator']
    expect(statePosition(state({ currentLocator: unknown, bookFraction: 0.5 }))).toBeNull()
    expect(decideServerState({ local: null, localFileId: 'f', server: state({ currentLocator: unknown, bookFraction: 0.5 }), reader: null })).toBe('keep')
  })

  it('statePosition_TransitionalFractionAtEitherEnd_KeptJustOutside_Null', () => {
    // #1187 QA: [0, 1] is closed; anything past it, or not a finite number, is no position.
    const other = { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x' } } as const
    for (const bookFraction of [0, 1]) expect(statePosition(state({ currentLocator: other, bookFraction }))).toMatchObject({ fraction: bookFraction })
    for (const bookFraction of [1.0000001, -Number.MIN_VALUE, Infinity, -Infinity, '0.5' as unknown as number, undefined as unknown as number]) {
      expect(statePosition(state({ currentLocator: other, bookFraction })), String(bookFraction)).toBeNull()
    }
    // The pdf-page exclusion holds at the ends too, and a fraction-only answer never carries a cfi.
    expect(statePosition(state({ currentLocator: { version: 1, scheme: 'pdf-page', value: 3 }, bookFraction: 0 }))).toBeNull()
    expect(Object.keys(statePosition(state({ currentLocator: other }))!).sort()).toEqual(['at', 'fraction'])
  })

  it('syncableText_OverCapOrWhitespace_NeverSynced_OldEntryUsesQuote', () => {
    expect(syncableText(hl({ selectedText: 'x'.repeat(4001) }))).toBeNull()
    expect(syncableText(hl({ selectedText: ' \n\t' }))).toBeNull()
    expect(syncableText(hl({ selectedText: undefined, quote: 'full old selection' }))).toBe('full old selection')
    expect(highlightWrite(hl({ selectedText: 'x'.repeat(4001) }), 'b', 'f', null)).toBeNull()
  })

  it('highlightWrite_ContextOverBound_CutNearestTheSelection', () => {
    const w = highlightWrite(hl({ prefix: `${'p'.repeat(40)}END`, suffix: `START${'s'.repeat(40)}`, quote: 'q'.repeat(100) }), 'b', 'f', null)!
    expect(w.locator).toMatchObject({ scheme: 'epub-cfi', value: CFI })
    expect(Array.from(w.locator!.quote!)).toHaveLength(64)
    expect(w.locator!.prefix!.endsWith('END')).toBe(true)
    expect(w.locator!.suffix!.startsWith('START')).toBe(true)
    expect(w.locator!.prefix).toHaveLength(32)
  })

  it('annotationHighlight_PulledEpubCfi_PageShape_TransitionalAnchorNull', () => {
    const a: V2Annotation = {
      id: 'a', bookId: 'b', fileId: 'f', selectedText: 'bright cold', noteText: null, color: 'yellow',
      locator: { version: 1, scheme: 'epub-cfi', value: CFI, quote: 'bright', prefix: 'a ', suffix: ' day' },
      createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', deletedAt: null, revision: 1,
    }
    expect(annotationHighlight(a)).toMatchObject({ id: 'a', cfi: CFI, index: 6, quote: 'bright', selectedText: 'bright cold' })
    expect(annotationHighlight({ ...a, locator: { version: 1, scheme: 'textstack-anchor-v1', value: {} } })).toBeNull()
  })

  it('ownWrite_KeyOrderAndTimeZoneDiffer_StillOwn', () => {
    const sent = positionWrite(pos, 'f', null)!
    const stored = state({ currentLocator: { quote: pos.quote, value: CFI, scheme: 'epub-cfi', version: 1 }, clientRecordedAt: '2026-11-10T12:00:00+02:00' })
    expect(ownStateWrite(stored, sent)).toBe(true)
    expect(ownStateWrite(state({ fileId: 'g' }), sent)).toBe(false)
    const w = highlightWrite(hl(), 'b', 'f', null)!
    const a = { id: 'x', bookId: 'b', fileId: 'f', selectedText: w.selectedText, noteText: null, locator: { ...w.locator! }, color: 'yellow', createdAt: '', updatedAt: '', deletedAt: null, revision: 1 }
    expect(ownAnnotationWrite(a, w)).toBe(true)
    expect(ownAnnotationWrite({ ...a, color: 'green' }, w)).toBe(false)
    expect(ownAnnotationWrite({ ...a, deletedAt: 'now' }, w)).toBe(false)
    expect(sameJson({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })

  it('ownWrite_AnotherDevicesWriteDiffersInOneField_NotOwn', () => {
    // Too loose here = a real conflict taken as success: this device's write silently dropped.
    const sent = positionWrite(pos, 'f', null)!
    expect(ownStateWrite(state({ clientRecordedAt: sent.clientRecordedAt }), sent)).toBe(true)
    expect(ownStateWrite(state({ clientRecordedAt: '2026-11-10T10:00:00.001Z' }), sent)).toBe(false)
    expect(ownStateWrite(state({ clientRecordedAt: sent.clientRecordedAt, fileId: 'g' }), sent)).toBe(false)
    expect(ownStateWrite(state({ clientRecordedAt: sent.clientRecordedAt, currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/14!/4/2/9:0)', quote: pos.quote } }), sent)).toBe(false)
    const w = highlightWrite(hl(), 'b', 'f', null)!
    const a = { id: 'x', bookId: 'b', fileId: 'f', selectedText: w.selectedText, noteText: null, locator: { ...w.locator! }, color: 'yellow', createdAt: '', updatedAt: '', deletedAt: null, revision: 1 }
    expect(ownAnnotationWrite({ ...a, selectedText: 'bright cold day' }, w)).toBe(false)
    expect(ownAnnotationWrite({ ...a, fileId: 'g' }, w)).toBe(false)
  })

  it('syncableText_ExactlyAtTheCap_Synced', () => {
    expect(syncableText(hl({ selectedText: 'x'.repeat(4000) }))).toHaveLength(4000)
  })

  it('isUuid_UuidInsideAnotherId_NotAUuid', () => {
    expect(isUuid('lb_0b6a2c1e-1111-4222-8333-444455556666')).toBe(false)
    expect(isUuid('0b6a2c1e-1111-4222-8333-444455556666x')).toBe(false)
  })

  describe('decideServerState (ADR-019 rule 5 by CFI + spine index)', () => {
    const local = { ...pos } // 10:00; the server's is 11:00
    const now = Date.parse('2026-11-10T12:00:00Z')
    it('decideServerState_ServerNotNewer_Keep', () => {
      expect(decideServerState({ local: { ...pos, at: now }, localFileId: 'f', server: state(), reader: null, now })).toBe('keep')
    })
    it('decideServerState_OtherFileOrScheme_Keep', () => {
      expect(decideServerState({ local, localFileId: 'g', server: state(), reader: null, now })).toBe('keep')
      expect(decideServerState({ local, localFileId: 'f', server: state({ currentLocator: { version: 1, scheme: 'pdf-page', value: 3 } }), reader: null, now })).toBe('keep')
    })
    describe('a transitional textstack-* state (fraction-only, #1187)', () => {
      const transitional = (extra: Partial<V2ReadingState> = {}) =>
        state({ currentLocator: { version: 1, scheme: 'textstack-position-v1', value: { chapterSlug: 'x' } }, bookFraction: 0.7, ...extra })
      it('decideServerState_TransitionalNotNewerThanLocalCfi_Keep', () => {
        expect(decideServerState({ local: { ...pos, at: now }, localFileId: 'f', server: transitional(), reader: { restoreApplied: true, moved: false, index: 6 }, now })).toBe('keep')
        expect(decideServerState({ local, localFileId: 'g', server: transitional(), reader: null, now })).toBe('keep')
      })
      it('decideServerState_TransitionalNewerNotOpenOrNotRestored_Adopt', () => {
        expect(decideServerState({ local, localFileId: 'f', server: transitional(), reader: null, now })).toBe('adopt')
        expect(decideServerState({ local: null, localFileId: 'f', server: transitional(), reader: { restoreApplied: false, moved: false, index: null }, now })).toBe('adopt')
      })
      it('decideServerState_TransitionalNewerReaderRestored_PromptNeverSilentMove', () => {
        // No spine index to call it the same chapter: a restored local CFI position is asked about, never replaced.
        expect(decideServerState({ local, localFileId: 'f', server: transitional(), reader: { restoreApplied: true, moved: false, index: 6 }, now })).toBe('prompt')
        expect(decideServerState({ local, localFileId: 'f', server: transitional(), reader: { restoreApplied: true, moved: true, index: null }, now })).toBe('prompt')
      })
      it('decideServerState_TransitionalNewerReaderWithoutIndex_PromptNotAMissingIndexMatch', () => {
        // #1187 QA: no spine index on either side is not "the same chapter" (null vs undefined).
        expect(decideServerState({ local, localFileId: 'f', server: transitional(), reader: { restoreApplied: true, moved: false, index: null }, now })).toBe('prompt')
      })
      it('decideServerState_LocalFractionOnlyReaderNotMoved_PromptNotSilentMove', () => {
        // #1187 round 3: the host's moved flag alone is no guard against a silent move (a fraction-0
        // restore emits no trailing relocate, so the first page turn becomes the baseline): asked.
        const landed = { fraction: 0.7, at: pos.at }
        for (const server of [transitional(), state()]) {
          for (const index of [1, null]) {
            expect(decideServerState({ local: landed, localFileId: 'f', server, reader: { restoreApplied: true, moved: false, index }, now })).toBe('prompt')
          }
        }
        expect(decideServerState({ local: { fraction: 0.7, at: now }, localFileId: 'f', server: transitional(), reader: { restoreApplied: true, moved: false, index: 1 }, now })).toBe('keep')
      })
    })
    it('decideServerState_NewerBookNotOpen_Adopt', () => {
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: null, now })).toBe('adopt')
      expect(decideServerState({ local: null, localFileId: 'f', server: state(), reader: null, now })).toBe('adopt')
    })
    it('decideServerState_NewerOpenNotRestored_Adopt', () => {
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: { restoreApplied: false, moved: false, index: 6 }, now })).toBe('adopt')
      // Before `restored` the host has no spine index yet: still adopt, never prompt.
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: { restoreApplied: false, moved: false, index: null }, now })).toBe('adopt')
    })
    it('decideServerState_NewerRestoredNotMovedSameSpine_Move', () => {
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: { restoreApplied: true, moved: false, index: 6 }, now })).toBe('move')
    })
    it('decideServerState_NewerReaderMovedOrOtherSpine_Prompt', () => {
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: { restoreApplied: true, moved: true, index: 6 }, now })).toBe('prompt')
      expect(decideServerState({ local, localFileId: 'f', server: state(), reader: { restoreApplied: true, moved: false, index: 2 }, now })).toBe('prompt')
    })
  })
})
