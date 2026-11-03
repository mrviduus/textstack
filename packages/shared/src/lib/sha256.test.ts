import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { createSha256 } from './sha256'

const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff)

function chunked(b: Uint8Array, size: number) {
  const h = createSha256()
  for (let at = 0; at < b.length; at += size) h.update(b.subarray(at, at + size))
  return h.hex()
}

describe('createSha256', () => {
  // Every padding case: 55/56/63/64 (one vs two final blocks) and around 2 blocks.
  it('update_EveryLength0To200_MatchesNodeDigest', () => {
    for (let n = 0; n <= 200; n++) expect(createSha256Hex(bytes(n)), `length ${n}`).toBe(node(bytes(n)))
  })

  it('update_OddChunkSizes_MatchesNodeDigest', () => {
    const b = bytes(1000)
    for (const size of [1, 3, 7, 55, 56, 63, 64, 65, 127, 999, 1000, 4096]) expect(chunked(b, size), `chunk ${size}`).toBe(node(b))
  })

  it('update_EmptyUpdatesInterleaved_Ignored', () => {
    const h = createSha256()
    h.update(new Uint8Array(0)); h.update(bytes(70)); h.update(new Uint8Array(0))
    expect(h.hex()).toBe(node(bytes(70)))
  })

  it('hex_KnownVector_Abc', () => {
    const h = createSha256()
    h.update(new TextEncoder().encode('abc'))
    expect(h.hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

function createSha256Hex(b: Uint8Array) {
  const h = createSha256()
  h.update(b)
  return h.hex()
}
