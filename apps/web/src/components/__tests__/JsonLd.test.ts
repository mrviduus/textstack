import { describe, it, expect } from 'vitest'
import { serializeJsonLd } from '../JsonLd'

describe('serializeJsonLd', () => {
  it('never emits a raw "<", and still round-trips', () => {
    const data = { name: 'A </script><b>x</b>', n: 1 }
    const out = serializeJsonLd(data)
    expect(out).not.toContain('<')
    expect(JSON.parse(out)).toEqual(data)
  })
})
