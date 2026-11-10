import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fb2, mobi, png } from './fixtures.mjs'
import { isTextual, mobiEncryption, sniffFormat, zipFormat } from './formats.mjs'

const bytes = (b: Buffer | string) => new Uint8Array(Buffer.from(b))
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

  it('pdf_RefusedForNow', () => {
    expect(() => sniffFormat(bytes('%PDF-1.7\n'))).toThrow(/PDF is not supported yet/)
  })

  it('unknownOrEmpty_Refused', () => {
    for (const b of ['', 'plain text', '<html><body>FictionBook</body></html>', '<FictionBookmark/>', png(1, 1, [0, 0, 0])])
      expect(() => sniffFormat(bytes(b))).toThrow(/not a book this reader opens/)
  })
})

describe('mobiEncryption', () => {
  it('readsRecordZerosPalmDocFlag', () => {
    expect(mobiEncryption(bytes(mobi('T', html)))).toBe(0)
    expect(mobiEncryption(bytes(mobi('T', html, { encryption: 2 })))).toBe(2)
  })

  it('recordZeroPastTheEnd_ReadsAsNone_LeftToTheParser', () => {
    const b = bytes(mobi('T', html)).slice(0, 90)
    expect(mobiEncryption(b)).toBe(0)
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
  // KNOWN BUG (QA #1128): IMAGE is case-insensitive, comic-book.js matches lower-case extensions only.
  // `it.fails` holds while they disagree; it turns red once they agree, then make it a plain `it`.
  it.skipIf(!existsSync(resolve(__dirname, '.vendor/foliate-js/comic-book.js'))).fails('upperCaseExtensions_RoutedCbz_AndTheComicReaderKeepsEveryPage', async () => {
    const names = ['P01.JPG', 'p02.png', 'P03.Png']
    expect(zipFormat(names)).toBe('cbz')
    const { makeComicBook } = await import('./.vendor/foliate-js/comic-book.js')
    const book = makeComicBook({ entries: names.map((filename) => ({ filename })), loadBlob: async () => null, getSize: () => 0 }, { name: '' })
    expect(book.sections.map((s: { id: string }) => s.id)).toEqual(names)
  })
})

describe('isTextual', () => {
  it('onlyComicBooksHaveNoText', () => {
    expect(['epub', 'mobi', 'fb2'].map(isTextual)).toEqual([true, true, true])
    expect(isTextual('cbz')).toBe(false)
  })
})
