import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fb2, mobi, png } from './fixtures.mjs'
import { checkFb2, comicName, fb2AsUtf8, imageType, isTextual, mobiHeader, sniffFormat, zipFormat } from './formats.mjs'
import { SYNTHETIC } from './kf8fixture.mjs'

const bytes = (b: Buffer | string) => new Uint8Array(Buffer.from(b))
/** A fresh copy of a committed synthetic book (synthetic/, kf8fixture.mjs). */
const synthetic = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, 'synthetic', name)))
const r0 = (b: Uint8Array) => new DataView(b.buffer).getUint32(78)
const html = '<html><body><p>Text</p></body></html>'

describe('sniffFormat', () => {
  it('zip_ByLocalFileHeader', () => {
    expect(sniffFormat(bytes(Buffer.from('504b0304140000', 'hex')))).toBe('zip')
  })

  it('mobi_ByPdbTypeAndCreator', () => {
    expect(sniffFormat(bytes(mobi('T', html)))).toBe('mobi')
  })

  it('mobiWithDrmFlag_RefusedAsDrm', () => {
    for (const encryption of [1, 2]) expect(() => sniffFormat(bytes(mobi('T', html, { encryption })))).toThrow(/DRM-protected/)
  })

  it('kfx_RefusedAsDrm', () => {
    expect(() => sniffFormat(bytes(Buffer.concat([Buffer.from([0xea]), Buffer.from('DRMION'), Buffer.from([0xee]), Buffer.alloc(100)])))).toThrow(/DRM-protected \(KFX\)/)
  })

  it('fb2_ByRootElement_AfterBomAndDeclaration', () => {
    expect(sniffFormat(bytes(`﻿${fb2('T', '<section><p>p</p></section>')}`))).toBe('fb2')
  })

  it('fb2_RootNearTheEndOfTheFirstKiB_StillFb2', () => {
    const book = fb2('T', '<section><p>p</p></section>', `<!-- ${'x'.repeat(900)} -->`)
    expect(book.indexOf('<FictionBook')).toBeGreaterThan(900)
    expect(book.indexOf('<FictionBook')).toBeLessThan(1024 - 13)
    expect(sniffFormat(bytes(book))).toBe('fb2')
  })

  it('mobiMagicOneByteOff_NotMobi', () => {
    const b = bytes(mobi('T', html))
    b[60] = 'b'.charCodeAt(0)
    expect(() => sniffFormat(b)).toThrow(/not a book this reader opens/)
  })

  it('pdf_ByHeaderInTheFirstKiB', () => {
    // #1128 S5: read by pdf.js; junk before the header is common, past the first KiB it is no PDF.
    expect(sniffFormat(bytes('%PDF-1.7\n'))).toBe('pdf')
    expect(sniffFormat(bytes(`${' '.repeat(1019)}%PDF-1.4\n`))).toBe('pdf')
    expect(() => sniffFormat(bytes(`${' '.repeat(1020)}%PDF-1.4\n`))).toThrow(/not a book this reader opens/)
  })

  it('pdfMarkerInTheFirstKiBOfAZipMobiOrKfx_StillThatFormat', () => {
    // #1128 S5 QA: the PDF sniff is a substring search, so it must run after every format told by its own
    // magic: a zip (an EPUB whose first entry is named so), a PDB whose name says so, a KFX.
    expect(sniffFormat(bytes(Buffer.concat([Buffer.from('504b0304140000', 'hex'), Buffer.from('%PDF-1.4 entry.xhtml')])))).toBe('zip')
    const named = bytes(mobi('%PDF-1.4 in the title', html))
    expect(Buffer.from(named.subarray(0, 1024)).toString('latin1')).toContain('%PDF-')
    expect(sniffFormat(named)).toBe('mobi')
    expect(() => sniffFormat(bytes(Buffer.concat([Buffer.from([0xea]), Buffer.from('DRMION'), Buffer.from([0xee]), Buffer.from('%PDF-1.4')])))).toThrow(/DRM-protected \(KFX\)/)
  })

  // QA #1128 S5 (bug): an FB2 is the last candidate, after the PDF substring search, so a valid FB2 whose
  // first KiB quotes `%PDF-` (a book about file formats, a <binary> name) goes to pdf.js and fails to open.
  it.fails('fb2QuotingThePdfMarkerInItsFirstKiB_StillFb2', () => {
    const book = fb2('About %PDF-1.4 headers', '<section><p>p</p></section>')
    expect(book.indexOf('%PDF-')).toBeLessThan(1024)
    expect(sniffFormat(bytes(book))).toBe('fb2')
  })

  it('unknownOrEmpty_Refused', () => {
    for (const b of ['', 'plain text', '<html><body>FictionBook</body></html>', '<FictionBookmark/>', png(1, 1, [0, 0, 0])])
      expect(() => sniffFormat(bytes(b))).toThrow(/not a book this reader opens/)
  })
})

describe('mobiHeader', () => {
  it('readsRecordZerosPalmDocFlagAndVersion', () => {
    expect(mobiHeader(bytes(mobi('T', html)))).toEqual({ encryption: 0, version: 6, boundary: undefined, base: 0 })
    expect(mobiHeader(bytes(mobi('T', html, { encryption: 2 }))).encryption).toBe(2)
    expect(mobiHeader(bytes(mobi('T', html, { version: 8 }))).version).toBe(8)
  })

  it('truncated_RefusedAsDamaged_NeverAsDrm', () => {
    // 78–81 bytes used to read the PDB name as the DRM flag.
    for (const n of [68, 78, 81, 90, 200]) {
      const b = bytes(mobi('T'.repeat(31), html, { encryption: 0 })).slice(0, n)
      expect(() => sniffFormat(b), String(n)).toThrow(/truncated or damaged/)
    }
  })

  it('kf8WithIndexes_GoesToTheMobiReader', () => {
    expect(mobiHeader(synthetic('tssynthetic-kf8.azw3'))).toMatchObject({ encryption: 0, version: 8, boundary: undefined })
    expect(sniffFormat(synthetic('tssynthetic-kf8.azw3'))).toBe('mobi')
  })

  it('kf8HeaderOnly_RefusedAsDamaged', () => {
    expect(() => sniffFormat(bytes(mobi('T', html, { version: 8 })))).toThrow(/truncated or damaged/)
  })

  it('kf8SkelOrFragNotAnIndex_RefusedAsDamaged', () => {
    for (const at of [248, 252]) for (const record of [1, 0xffff, 0xffffffff]) {
      const b = synthetic('tssynthetic-kf8.azw3')
      new DataView(b.buffer).setUint32(r0(b) + at, record)
      expect(() => sniffFormat(b), `${at} → ${record}`).toThrow(/truncated or damaged/)
    }
  })

  it('kf8WithDrmFlag_RefusedAsDrm', () => {
    for (const encryption of [1, 2]) {
      const b = synthetic('tssynthetic-kf8.azw3')
      new DataView(b.buffer).setUint16(r0(b) + 12, encryption)
      expect(() => sniffFormat(b)).toThrow(/DRM-protected/)
    }
  })

  it('combo_ItsKf8HalfChecked_DrmAndIndexes', () => {
    const b = synthetic('tssynthetic-combo.mobi')
    const h = mobiHeader(b)
    expect(h).toMatchObject({ version: 6, boundary: 13 })
    expect(mobiHeader(b, 13)).toMatchObject({ version: 8, base: 13, skel: 9, frag: 6 })
    expect(sniffFormat(b)).toBe('mobi')
    const kf8 = new DataView(b.buffer).getUint32(78 + 13 * 8)
    const drm = synthetic('tssynthetic-combo.mobi')
    new DataView(drm.buffer).setUint16(kf8 + 12, 2)
    expect(() => sniffFormat(drm)).toThrow(/DRM-protected/)
    const damaged = synthetic('tssynthetic-combo.mobi')
    new DataView(damaged.buffer).setUint32(kf8 + 252, 1)
    expect(() => sniffFormat(damaged)).toThrow(/truncated or damaged/)
  })

  it('combo_BoundaryAtNoMobiHeader_Mobi6', () => {
    // foliate falls back to the MOBI6 half when the boundary record holds no MOBI header.
    for (const boundary of [1, 99, 0xffffffff]) expect(sniffFormat(bytes(mobi('T', html, { boundary }))), String(boundary)).toBe('mobi')
  })
})

describe('synthetic KF8 fixtures', () => {
  it('committedFiles_MatchTheRecipesRecordedHashes', () => {
    for (const [name, [sha256, size]] of Object.entries(SYNTHETIC)) {
      const b = readFileSync(resolve(__dirname, 'synthetic', name))
      expect([createHash('sha256').update(b).digest('hex'), b.length], name).toEqual([sha256, size])
    }
  })
})

describe('fb2', () => {
  const book = fb2('T', '<section><p>Ünïcode</p></section>')

  it('utf16_EitherOrderWithOrWithoutBom_SniffedAndReencodedAsUtf8', () => {
    const le = Buffer.from(`﻿${book.replace('utf-8', 'UTF-16')}`, 'utf16le')
    const be = Buffer.from(le).swap16()
    for (const b of [le, be, le.subarray(2)]) {
      expect(sniffFormat(bytes(b))).toBe('fb2')
      const text = new TextDecoder().decode(fb2AsUtf8(bytes(b)))
      expect(text).toContain('<?xml version="1.0" encoding="utf-8"?>')
      expect(text).toContain('Ünïcode')
    }
    expect(fb2AsUtf8(bytes(book))).toEqual(bytes(book))
  })

  it('rootWithin4KiB_Fb2', () => {
    expect(sniffFormat(bytes(fb2('T', '<section/>', `<!-- ${'x'.repeat(3500)} -->`)))).toBe('fb2')
  })

  it('anyDeclaredEntity_RefusedBeforeParsing', () => {
    for (const d of ['<!ENTITY e "x">', '<!ENTITY x SYSTEM "http://evil/x">', '<!ENTITY % p "x">'])
      expect(() => sniffFormat(bytes(fb2('T', '<section/>', `<!DOCTYPE FictionBook [${d}]>`))), d).toThrow(/custom entities/)
    expect(() => checkFb2(bytes(fb2('T', '<section/>', '<!DOCTYPE FictionBook [<!ENTITY e "x">]>')))).toThrow(/custom entities/)
    expect(() => checkFb2(bytes(book))).not.toThrow()
  })
})

describe('comic pages', () => {
  it('comicName_LowerCasesOnlyTheExtension', () => {
    expect(['P01.JPG', 'Dir.X/p02.Png', 'p03.png', 'noext'].map(comicName)).toEqual(['P01.jpg', 'Dir.X/p02.png', 'p03.png', 'noext'])
  })

  it('imageType_ByExtension_SvgTyped', () => {
    expect(['a.svg', 'b.JPG', 'c.webp', 'd.txt'].map(imageType)).toEqual(['image/svg+xml', 'image/jpeg', 'image/webp', ''])
  })
})

describe('zipFormat', () => {
  it('ocfContainer_Epub_EvenWithImages', () => {
    expect(zipFormat(['mimetype', 'META-INF/container.xml', 'OEBPS/cover.png'])).toBe('epub')
  })

  it('fb2Inside_Fbz', () => {
    expect(zipFormat(['Book.FB2'])).toBe('fbz')
  })

  it('imagesOnly_Cbz', () => {
    expect(zipFormat(['ComicInfo.xml', '001.jpg', '002.webp'])).toBe('cbz')
  })

  it('nothingReadable_Refused', () => {
    expect(() => zipFormat(['readme.txt'])).toThrow(/no book in it/)
  })

  // The router and the fork's comic reader must agree on what a page is: a zip routed `cbz` whose pages the
  // reader then filters out opens as `open-failed` ("No supported image files"), or with pages missing.
  // zipFormat is case-insensitive and comic-book.js matches lower-case extensions only, so the page hands the
  // comic reader comicName's (QA #1128; was `it.fails`). formats.check opens a real upper-case CBZ.
  it.skipIf(!existsSync(resolve(__dirname, '.vendor/foliate-js/comic-book.js')))('upperCaseExtensions_RoutedCbz_AndTheComicReaderKeepsEveryPage', async () => {
    const names = ['P01.JPG', 'p02.png', 'P03.Png']
    expect(zipFormat(names)).toBe('cbz')
    // @ts-ignore — .vendor/ is the build-time clone (gitignored); CI's typecheck runs without it, and
    // the skipIf above keeps the test itself from running there.
    const { makeComicBook } = await import('./.vendor/foliate-js/comic-book.js')
    const book = makeComicBook({ entries: names.map((n) => ({ filename: comicName(n) })), loadBlob: async () => null, getSize: () => 0 }, { name: '' })
    expect(book.sections.map((s: { id: string }) => s.id)).toEqual(names.map(comicName))
  })
})

describe('isTextual', () => {
  it('onlyComicBooksHaveNoText', () => {
    expect(['epub', 'mobi', 'fb2'].map(isTextual)).toEqual([true, true, true])
    expect(isTextual('cbz')).toBe(false)
  })
})
