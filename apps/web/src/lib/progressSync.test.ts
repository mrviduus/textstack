import { describe, it, expect, afterEach, vi } from 'vitest'

import { keepaliveWrite } from './progressSync'

describe('keepaliveWrite', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('keepaliveWrite_PutWithItsJsonBody_DeleteWithNone_BothKeptAliveWithTheCookie', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await keepaliveWrite('/a', '{"x":1}')
    await keepaliveWrite('/b', null, 'DELETE')
    expect(fetchMock.mock.calls).toEqual([
      ['/a', { method: 'PUT', credentials: 'include', keepalive: true, body: '{"x":1}', headers: { 'Content-Type': 'application/json' } }],
      ['/b', { method: 'DELETE', credentials: 'include', keepalive: true, headers: {} }],
    ])
  })
})
