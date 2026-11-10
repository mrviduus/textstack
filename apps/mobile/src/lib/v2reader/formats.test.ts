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

  it('pdf_RefusedForNow', () => {
    expect(() => sniffFormat(bytes('%PDF-1.7\n'))).toThrow(/PDF is not supported yet/)
  })

  it('unknownOrEmpty_Refused', () => {
    for (const b of ['', 'plain text', '<html><body>FictionBook</body></html>', png(1, 1, [0, 0, 0])])
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
})

describe('isTextual', () => {
  it('onlyComicBooksHaveNoText', () => {
    expect(['epub', 'mobi', 'fb2'].map(isTextual)).toEqual([true, true, true])
    expect(isTextual('cbz')).toBe(false)
  })
})
