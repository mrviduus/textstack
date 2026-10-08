import { describe, it, expect, vi, afterEach } from 'vitest'
import { translate } from '../translation'

// Review of #780: the web client builds its body with the shared translateBody, so it
// follows the same rule as mobile — sentence only for a word or short phrase.
describe('web translate body', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function bodyFor(text: string, sentence: string) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ translatedText: 'x' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await translate(text, 'en', 'pt', undefined, { sentence, bookId: 'b1' })
    return JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
  }

  it('translate_Word_SendsSentence', async () => {
    expect((await bodyFor('pocketed', 'He pocketed the coins.')).sentence).toBe('He pocketed the coins.')
  })

  it('translate_Passage_OmitsSentence', async () => {
    const body = await bodyFor('He pocketed the coins and', 'He pocketed the coins and left.')
    expect(body.sentence).toBeUndefined()
    expect(body.bookId).toBe('b1')
  })
})
