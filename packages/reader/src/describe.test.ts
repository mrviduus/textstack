// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MAX_COVER_BYTES, MAX_META_DESCRIPTION, MAX_META_TITLE, bookMeta, readDescribed } from './describe.mjs'

const meta = { title: 'Dune', author: 'Frank Herbert', lang: 'en', description: 'A desert planet.' }
const jpeg = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes).toString('base64')}`
const described = (o: object = {}) => ({ type: 'described', id: 'up-1', meta, cover: jpeg(1000), ...o })

describe('v2 reader describe', () => {
  it('bookMeta_EpubWithTwoAuthorsAndHtmlBlurb_ReadsAsTheLibraryShowsIt', () => {
    const m = bookMeta({
      title: { uk: 'Дюна', en: 'Dune' },
      author: [{ name: { en: 'Frank Herbert' } }, 'Brian Herbert', { name: '' }],
      language: ['en-US'],
      description: '<p>A <b>desert</b> planet.</p><p>Spice.<script>alert(1)</script></p><img src=x onerror="alert(2)">',
    }, 'en-GB')
    expect(m).toEqual({ title: 'Dune', author: 'Frank Herbert, Brian Herbert', lang: 'en', description: 'A desert planet.\nSpice.' })
    // No UI-language match: the map's first value. Nothing in the file: empty strings, a junk language dropped.
    expect(bookMeta({ title: { uk: 'Дюна', en: 'Dune' }, language: '<b>' }, 'fr').title).toBe('Дюна')
    expect(bookMeta(undefined)).toEqual({ title: '', author: '', lang: '', description: '' })
  })

  it('readDescribed_HostileBook_CannotHandTheAppMarkupOrAHugeCover', () => {
    expect(readDescribed(described())).toEqual({ id: 'up-1', meta, cover: jpeg(1000), toc: [] })
    expect(readDescribed(described({ cover: null }))?.cover).toBeNull()
    expect(readDescribed(described({ meta: null, cover: null, error: 'this PDF is password-protected and cannot be opened' }))?.error).toMatch(/password/)
    for (const bad of [
      described({ cover: 'data:image/png;base64,AAAA' }),
      described({ cover: 'data:image/svg+xml,<svg onload="x()"/>' }),
      described({ cover: 'javascript:alert(1)' }),
      described({ cover: 'data:image/jpeg;base64,<script>' }),
      described({ cover: jpeg(MAX_COVER_BYTES + 1) }),
      described({ meta: { ...meta, title: 'x'.repeat(MAX_META_TITLE + 1) } }),
      described({ meta: { ...meta, description: 'x'.repeat(MAX_META_DESCRIPTION + 1) } }),
      described({ meta: { ...meta, author: ['a'] } }),
      described({ id: '' }),
      described({ type: 'opened' }),
    ]) expect(readDescribed(bad)).toBeNull()
    expect(readDescribed(described({ cover: jpeg(MAX_COVER_BYTES) }))).not.toBeNull()
  })
})
