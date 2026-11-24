import { describe, it, expect } from 'vitest'
import { isUploadableFile, partitionFiles } from './uploadFileValidation'

function file(name: string, type = ''): File {
  return new File([new Blob(['x'])], name, { type })
}

describe('isUploadableFile', () => {
  it('accepts .epub by extension', () => {
    expect(isUploadableFile(file('book.epub'))).toBe(true)
  })
  it('accepts .pdf by extension', () => {
    expect(isUploadableFile(file('paper.pdf'))).toBe(true)
  })
  it('accepts the other formats the reader opens: mobi, azw3, fb2, fbz, cbz', () => {
    for (const n of ['a.mobi', 'a.azw3', 'a.fb2', 'a.fbz', 'a.cbz']) expect(isUploadableFile(file(n))).toBe(true)
  })
  it('accepts uppercase extensions', () => {
    expect(isUploadableFile(file('BOOK.EPUB'))).toBe(true)
  })
  it('rejects .txt', () => {
    expect(isUploadableFile(file('readme.txt'))).toBe(false)
  })
  it('rejects .docx', () => {
    expect(isUploadableFile(file('doc.docx'))).toBe(false)
  })
  it('rejects image.png', () => {
    expect(isUploadableFile(file('image.png', 'image/png'))).toBe(false)
  })
  it('rejects file with no extension', () => {
    expect(isUploadableFile(file('noext'))).toBe(false)
  })
  it('rejects a file without a known extension whatever its mimetype (the format comes from the name)', () => {
    expect(isUploadableFile(file('weirdname', 'application/pdf'))).toBe(false)
    expect(isUploadableFile(file('archive.zip', 'application/zip'))).toBe(false)
  })
})

describe('partitionFiles', () => {
  it('splits valid and invalid files', () => {
    const files = [file('a.epub'), file('b.txt'), file('c.pdf')]
    const { valid, invalid } = partitionFiles(files)
    expect(valid.map(f => f.name)).toEqual(['a.epub', 'c.pdf'])
    expect(invalid.map(f => f.name)).toEqual(['b.txt'])
  })
  it('empty list returns empty arrays', () => {
    const { valid, invalid } = partitionFiles([])
    expect(valid).toEqual([])
    expect(invalid).toEqual([])
  })
})
