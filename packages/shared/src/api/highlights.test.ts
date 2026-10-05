import { describe, expect, it } from 'vitest'
import { updateHighlightBody } from './highlights'

describe('updateHighlightBody', () => {
  it('sends removeNote when the note is cleared to null', () => {
    expect(updateHighlightBody({ noteText: null, version: 2 })).toEqual({ removeNote: true, version: 2 })
  })

  it('sends removeNote when the note is cleared to blank', () => {
    expect(updateHighlightBody({ noteText: '  ' })).toEqual({ removeNote: true })
  })

  it('sends the note text when one is set', () => {
    expect(updateHighlightBody({ noteText: 'why', color: 'blue' })).toEqual({ noteText: 'why', color: 'blue' })
  })

  it('leaves the note out when it is not being changed', () => {
    const body = updateHighlightBody({ color: 'blue' })
    expect(body).toEqual({ color: 'blue' })
    expect('removeNote' in body).toBe(false)
  })
})
