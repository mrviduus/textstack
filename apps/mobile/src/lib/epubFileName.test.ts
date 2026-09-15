import { describe, it, expect } from 'vitest'
import { epubFileName } from './epubFileName'

const ID = '3f2b1c4d-0000-4000-8000-000000000001'

describe('epubFileName', () => {
  it('keeps an ordinary title, with its hyphen', () => {
    expect(epubFileName('The Mom Test - Rob Fitzpatrick', ID))
      .toBe('The Mom Test - Rob Fitzpatrick.epub')
  })

  it('strips path separators so the name cannot escape its directory', () => {
    expect(epubFileName('../../etc/passwd', ID)).toBe('etc passwd.epub')
    expect(epubFileName('a/b\\c', ID)).toBe('a b c.epub')
  })

  it('strips the Windows-reserved characters, quotes included', () => {
    expect(epubFileName('Wealth: Greed? "Happiness" <or> not|', ID))
      .toBe('Wealth Greed Happiness or not.epub')
  })

  it('drops leading dots so the file is not hidden', () => {
    expect(epubFileName('.hidden', ID)).toBe('hidden.epub')
  })

  it('falls back to the id when nothing usable survives', () => {
    expect(epubFileName('///', ID)).toBe(`${ID}.epub`)
    expect(epubFileName('   ', ID)).toBe(`${ID}.epub`)
    expect(epubFileName(null, ID)).toBe(`${ID}.epub`)
  })

  it('truncates the 200-character z-library titles the real library is full of', () => {
    const long = 'Designing Data-Intensive Applications The Big Ideas Behind Reliable, Scalable, and Maintainable Systems (Martin Kleppmann) (z-library.sk, 1lib.sk, z-lib.sk)'
    const name = epubFileName(long, ID)
    expect(name.length).toBeLessThanOrEqual(85)
    expect(name.endsWith('.epub')).toBe(true)
    expect(name.startsWith('Designing Data-Intensive Applications')).toBe(true)
  })

  it('keeps non-Latin titles — most of this library is not English', () => {
    expect(epubFileName('Смерть Ивана Ильича', ID)).toBe('Смерть Ивана Ильича.epub')
  })
})
