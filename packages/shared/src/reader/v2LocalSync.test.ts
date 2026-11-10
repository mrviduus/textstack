import { describe, it, expect } from 'vitest'
import type { V2Annotation, V2ReadingState } from '../api/v2'
import {
  annotationHighlight, codePoints, decideServerState, highlightWrite, isUuid, ownAnnotationWrite, ownStateWrite,
  positionWrite, sameJson, spineIndexOf, statePosition, syncableText, type PageHighlight,
} from './v2LocalSync'

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

  it('positionWrite_CbzPageWithoutQuote_Null', () => {
    expect(positionWrite({ cfi: CFI, page: 'p1.jpg', index: 0, fraction: 0, at: 1 }, 'f', null)).toBeNull()
  })

  it('statePosition_RoundTripsAPositionWrite_PdfPageNull', () => {
    expect(statePosition(state())).toMatchObject({ cfi: CFI, quote: pos.quote, index: 6, fraction: 0.41 })
    expect(statePosition(state({ currentLocator: { version: 1, scheme: 'pdf-page', value: 3 } }))).toBeNull()
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
