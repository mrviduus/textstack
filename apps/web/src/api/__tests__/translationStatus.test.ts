import { afterEach, describe, expect, it, vi } from 'vitest'
import '../client' // initApi
import { translate } from '../translation'

// #1271 review: a failed translation carries its HTTP status, so the backfill can stop on a 429.
afterEach(() => vi.unstubAllGlobals())

describe('translate', () => {
  it('answered429_TheErrorCarriesStatus429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Too many requests' }), { status: 429 })))
    await expect(translate('pond', 'en', 'uk')).rejects.toMatchObject({ status: 429, message: 'Too many requests' })
  })
})
