import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyEntry, entryFor, foldText, sha1, sha256, withHighlight, withPosition } from './store.mjs'

const book = { sha256: 'ab'.repeat(32), size: 1234, name: 'a.epub' }
const pos = { cfi: 'epubcfi(/6/8!/4/2/1:5)', quote: 'Alice was beginning', index: 3, fraction: 0.1, at: 1 }
const hl = { id: 'h1', cfi: 'epubcfi(/6/8!/4/2,/1:0,/1:9)', quote: 'down the rabbit-hole', prefix: '', suffix: '', color: 'yellow' }

describe('v2 reader store', () => {
  it('sha256_KnownVectorsAndBlockEdges_MatchNodeCrypto', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    for (const n of [0, 55, 56, 63, 64, 65, 1000, 70001]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255)
      expect(sha256(b), `length ${n}`).toBe(createHash('sha256').update(b).digest('hex'))
    }
  })

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

  it('sha256_EveryLengthAcrossThreeBlocks_MatchesNodeCryptoInLowerHex', () => {
    for (let n = 0; n <= 192; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 255)
      const h = sha256(b)
      expect(h, `length ${n}`).toBe(createHash('sha256').update(b).digest('hex'))
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('foldText_EmptyAndWhitespaceOnly_FoldToEmpty', () => {
    expect(foldText('')).toBe('')
    expect(foldText(' \n\t\u00A0\u00AD')).toBe('')
  })
})
