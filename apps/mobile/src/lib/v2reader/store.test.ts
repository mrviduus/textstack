import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyEntry, entryFor, foldText, quoteOf, sha1, sha256, sha256Yielding, withHighlight, withPosition } from './store.mjs'
import { uuidV4 } from './uuid.mjs'

const book = { sha256: 'ab'.repeat(32), size: 1234, name: 'a.epub' }
const pos = { cfi: 'epubcfi(/6/8!/4/2/1:5)', quote: 'Alice was beginning', index: 3, fraction: 0.1, at: 1 }
const hl = { id: 'h1', cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:9)', quote: 'down the rabbit-hole', prefix: '', suffix: '', color: 'yellow' }

describe('v2 reader store', () => {
  it('sha1_IdentifierStrings_MatchNodeCrypto', () => {
    for (const s of ['', 'abc', 'urn:uuid:2c4a3b8e-0000-4000-8000-000000000001', 'x'.repeat(55), 'x'.repeat(64), 'é'.repeat(40)]) {
      expect(Buffer.from(sha1(s)).toString('hex'), s).toBe(createHash('sha1').update(s).digest('hex'))
    }
  })

  it('entryFor_JsonRoundTrip_RestoresPositionAndHighlight', () => {
    const e = withHighlight(withPosition(emptyEntry(book), pos), hl)
    const back = entryFor(JSON.stringify(e), book)
    expect(back?.position).toEqual(pos)
    expect(back?.highlights).toEqual([hl])
  })

  it('entryFor_OtherFileOrVersionOrCorrupt_ReturnsNull', () => {
    const json = JSON.stringify(withPosition(emptyEntry(book), pos))
    expect(entryFor(json, { ...book, sha256: 'cd'.repeat(32) })).toBeNull()
    expect(entryFor(json, { ...book, size: 1235 })).toBeNull()
    expect(entryFor(json.replace('"v":1', '"v":2'), book)).toBeNull()
    expect(entryFor('{not json', book)).toBeNull()
  })

  it('withHighlight_SameId_ReplacesNotDuplicates', () => {
    const e = withHighlight(withHighlight(emptyEntry(book), hl), { ...hl, cfi: 'epubcfi(/6/8!/4/4,/1:0,/1:9)' })
    expect(e.highlights).toHaveLength(1)
    expect(e.highlights[0].cfi).toBe('epubcfi(/6/8!/4/4,/1:0,/1:9)')
  })

  it('imageBookPosition_PageInsteadOfQuote_KeptAndReadBack', () => {
    // CBZ (#1128): no text at any CFI, so no quote; the image's entry name is what restore checks.
    const paged = { cfi: 'epubcfi(/6/4)', page: 'p02.png', index: 1, fraction: 1, at: 1 }
    const e = withPosition(emptyEntry(book), paged)
    expect(e.position).toEqual(paged)
    expect(entryFor(JSON.stringify(e), book)?.position).toEqual(paged)
    // Neither half-shape passes: an empty page, or a page beside a quote.
    expect(withPosition(emptyEntry(book), { ...paged, page: '' }).position).toBeNull()
    expect(withPosition(emptyEntry(book), { ...paged, quote: '' }).position).toBeNull()
    // Nor a page without a CFI foliate can resolve, or with a non-string page.
    for (const bad of [{ ...paged, cfi: '/6/4' }, { ...paged, cfi: undefined }, { ...paged, page: 2 }])
      expect(entryFor(JSON.stringify({ ...e, position: bad }), book)?.position, JSON.stringify(bad)).toBeNull()
  })

  it('withPosition_WithoutCfiOrQuote_KeepsThePreviousOne', () => {
    const e = withPosition(emptyEntry(book), pos)
    expect(withPosition(e, { ...pos, quote: '' }).position).toEqual(pos)
    expect(withPosition(e, { ...pos, cfi: '/6/8' }).position).toEqual(pos)
  })

  it('foldText_CurlyQuotesDashesNbspSoftHyphens_ReadAsTheAsciiText', () => {
    expect(foldText('\u201CDon\u2019t\u201D \u2014 she said\u2026\u00A0twen\u00ADty\n')).toBe('"Don\'t"-shesaid...twenty')
  })

  it('entryFor_ProtoKeysInJson_DoNotPolluteObjectPrototype', () => {
    const json = `{"__proto__":{"polluted":1},"v":1,"book":{"sha256":"${book.sha256}","size":${book.size}},"position":null,"highlights":[],"constructor":{"prototype":{"polluted":1}}}`
    const e = entryFor(json, book)
    expect(e).not.toBeNull()
    expect(withHighlight(withPosition(e, pos), hl).highlights).toEqual([hl])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('entryFor_NonObjectOrWrongTypes_ReturnsNull', () => {
    for (const j of ['null', '[]', '1', '"x"', 'true', '{}', `{"v":1,"book":{"sha256":"${book.sha256}","size":"1234"},"highlights":[]}`])
      expect(entryFor(j, book), j).toBeNull()
    expect(entryFor(JSON.stringify({ ...emptyEntry(book), highlights: {} }), book)).toBeNull()
  })

  it('entryFor_UpperCaseHashOfSameBytes_IsNotTheSameFile', () => {
    // sha256() emits lower-case hex and the key is compared verbatim: a host that changes case loses the entry.
    expect(entryFor(JSON.stringify(emptyEntry(book)), { ...book, sha256: book.sha256.toUpperCase() })).toBeNull()
  })

  it('withPositionAndWithHighlight_AnyInput_DoNotMutateTheEntry', () => {
    const e = emptyEntry(book)
    withHighlight(withPosition(e, pos), hl)
    expect(e).toEqual({ v: 1, book, position: null, highlights: [] })
  })

  it('withHighlight_WithoutIdOrQuote_IsIgnored', () => {
    const e = emptyEntry(book)
    expect(withHighlight(e, { ...hl, id: '' })).toBe(e)
    expect(withHighlight(e, { ...hl, quote: '' })).toBe(e)
    expect(withHighlight(e, null)).toBe(e)
  })

  it('sha256_EveryLengthAcrossThreeBlocksAndBeyond_MatchesNodeCryptoInLowerHex', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const n of [...Array.from({ length: 193 }, (_, i) => i), 1000, 70001]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 255)
      const h = sha256(b)
      expect(h, `length ${n}`).toBe(createHash('sha256').update(b).digest('hex'))
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('entryFor_StoredItemsWithoutAQuote_AreDroppedSoRestoreCannotThrow', () => {
    // A highlight or position with no quote used to reach foldText(undefined): the page threw inside
    // restore, never sent `restored`, and then saved nothing for the rest of the session.
    const stored = { ...emptyEntry(book), position: { cfi: 'epubcfi(/6/8!/4/2/1:5)' }, highlights: [{ id: 'x' }, hl] }
    const e = entryFor(JSON.stringify(stored), book)
    expect(e).toMatchObject({ position: null, highlights: [hl] })
    for (const item of [e!.position, ...e!.highlights]) if (item) expect(() => foldText(item.quote)).not.toThrow()
    // Still the same file's entry, so the page goes on saving into it.
    expect(withPosition(e, pos).position).toEqual(pos)
  })

  it('sha256Yielding_MoreThanOneSlice_SameDigestAndGivesThePageBackBetweenSlices', async () => {
    // The whole blocks are read in the file's own buffer; only the 64-byte tail is copied, so an 80 MB
    // book neither freezes the page nor triples its memory.
    const bytes = Uint8Array.from({ length: (9 << 20) + 37 }, (_, i) => (i * 97) & 255)
    let yields = 0
    const digest = await sha256Yielding(bytes, async () => { yields++ })
    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(digest).toBe(sha256(bytes))
    expect(yields).toBe(3)
  })

  it('sha256Yielding_ShortAndEmptyInput_MatchesTheSyncOne', async () => {
    for (const n of [0, 1, 55, 56, 64, 65]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) & 255)
      expect(await sha256Yielding(b), `length ${n}`).toBe(sha256(b))
    }
  })

  it('sha256_ViewIntoALargerBuffer_HashesOnlyItsOwnBytes', () => {
    const whole = Uint8Array.from({ length: 300 }, (_, i) => i & 255)
    const part = whole.subarray(70, 270)
    expect(sha256(part)).toBe(createHash('sha256').update(part).digest('hex'))
  })

  it('foldText_EmptyAndWhitespaceOnly_FoldToEmpty', () => {
    expect(foldText('')).toBe('')
    expect(foldText(' \n\t\u00A0\u00AD')).toBe('')
  })

  it('quoteOf_SurrogatePairAtTheUtf16Cut_KeepsThePairAndCountsCodePoints', () => {
    // 63 ASCII + an emoji: a UTF-16 slice(0, 64) keeps only the emoji's high surrogate.
    const text = `${'a'.repeat(63)}\u{1F600}tail`
    expect(text.slice(0, 64)).toMatch(/[\uD800-\uDBFF]$/)
    expect(quoteOf(text)).toBe(`${'a'.repeat(63)}\u{1F600}`)
    // 64 CJK Extension B characters: 128 UTF-16 units, 64 code points, none of them split.
    const cjk = '\u{20000}'.repeat(70)
    expect([...quoteOf(cjk)]).toHaveLength(64)
    expect(new TextDecoder().decode(new TextEncoder().encode(quoteOf(cjk)))).toBe('\u{20000}'.repeat(64))
  })

  it('quoteOf_ShortOrMultiline_WholeTextUpTo64CodePoints', () => {
    expect(quoteOf('')).toBe('')
    expect(quoteOf('one\ntwo')).toBe('one\ntwo')
    expect(quoteOf('x'.repeat(100))).toBe('x'.repeat(64))
  })

  it('uuidV4_ManyCalls_UniqueLowercaseV4Shape', () => {
    const ids = new Set(Array.from({ length: 1000 }, uuidV4))
    expect(ids.size).toBe(1000)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('entryFor_HighlightWithSelectedText_RoundTripsBothFields', () => {
    const h = { ...hl, id: uuidV4(), quote: quoteOf('y'.repeat(200)), selectedText: 'y'.repeat(200) }
    const back = entryFor(JSON.stringify(withHighlight(emptyEntry(book), h)), book)
    expect(back?.highlights).toEqual([h])
    expect(back?.highlights[0].quote).toHaveLength(64)
  })

  it('entryFor_PreSelectedTextHighlight_StillRestored', () => {
    // Before #1078 the whole selection was the quote and there was no selectedText (ADR-031 M2.7a: transitional).
    const old = { ...hl, id: 'hmabc123', quote: 'z'.repeat(200) }
    expect(entryFor(JSON.stringify({ ...emptyEntry(book), highlights: [old] }), book)?.highlights).toEqual([old])
  })

  it('entryFor_SelectedTextNotANonEmptyString_HighlightDropped', () => {
    // ' \n ' too: the server refuses whitespace-only selections (SyncValidation.RequiredText).
    const bad = [{ ...hl, selectedText: '' }, { ...hl, selectedText: ' \n ' }, { ...hl, selectedText: 7 }, { ...hl, selectedText: null }]
    expect(entryFor(JSON.stringify({ ...emptyEntry(book), highlights: [...bad, hl] }), book)?.highlights).toEqual([hl])
    expect(withHighlight(emptyEntry(book), bad[1]).highlights).toEqual([])
  })
})
