import { describe, it, expect } from 'vitest'
import { scrubUrl, scrubEvent } from './sentryScrub'

// The app's entire purpose is reading books, much of it copyrighted or personal.
// A breadcrumb that records a TTS or translate request carries the passage the user
// was reading, and shipping that to a third-party processor is a disclosure we have
// not made. These are the endpoints that take the text in the query string.
describe('scrubUrl', () => {
  it('redacts the text sent to TTS', () => {
    expect(scrubUrl('https://textstack.app/api/tts?text=It%20was%20a%20dark%20night&lang=en'))
      .toBe('https://textstack.app/api/tts?text=[redacted]&lang=en')
  })

  it('redacts a translate call and a search query', () => {
    expect(scrubUrl('/api/translate?text=secret&target=uk')).toBe('/api/translate?text=[redacted]&target=uk')
    expect(scrubUrl('/api/search?q=my%20private%20book')).toBe('/api/search?q=[redacted]')
  })

  it('keeps non-sensitive parameters intact so URLs stay debuggable', () => {
    expect(scrubUrl('/api/books?page=2&sort=title')).toBe('/api/books?page=2&sort=title')
  })

  it('leaves URLs without a query string alone', () => {
    expect(scrubUrl('/api/me/library')).toBe('/api/me/library')
    expect(scrubUrl('')).toBe('')
  })

  it('is case-insensitive on the parameter name', () => {
    expect(scrubUrl('/api/tts?TEXT=hello')).toBe('/api/tts?TEXT=[redacted]')
  })
})

describe('scrubEvent', () => {
  it('scrubs breadcrumb URLs and the request URL', () => {
    const event = {
      breadcrumbs: [
        { data: { url: '/api/tts?text=chapter%20one' } },
        { data: { url: '/api/books?page=1' } },
        { data: {} },
        {},
      ],
      request: { url: '/api/explain?word=melancholy&sentence=a%20whole%20paragraph' },
    }
    const out = scrubEvent(event)
    expect((out.breadcrumbs![0] as { data: { url: string } }).data.url).toBe('/api/tts?text=[redacted]')
    expect((out.breadcrumbs![1] as { data: { url: string } }).data.url).toBe('/api/books?page=1')
    expect(out.request.url).toBe('/api/explain?word=[redacted]&sentence=[redacted]')
  })

  it('tolerates an event with nothing to scrub', () => {
    expect(scrubEvent({})).toEqual({})
  })
})
