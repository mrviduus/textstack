/**
 * Incremental SHA-256 in plain JS, for a client with no streaming digest: mobile hashes a picked
 * book part by part (Hermes has no `crypto.subtle`, and expo-crypto digests a whole buffer), so the
 * file is never in memory at once. Web uses the browser's own digest. Lowercase hex out, as V2's
 * `sha256` (PDD "File sync upload protocol").
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export interface Sha256 {
  update(bytes: Uint8Array): void
  /** Ends the hash; the hasher is spent after it. */
  hex(): string
}

export function createSha256(): Sha256 {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  const block = new Uint8Array(64)
  let filled = 0
  let length = 0

  const compress = (b: Uint8Array, at: number) => {
    for (let i = 0; i < 16; i++) {
      const j = at + i * 4
      W[i] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2]
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)
      W[i] = W[i - 16] + s0 + W[i - 7] + s1
    }
    let a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & b2) ^ (a & c) ^ (b2 & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0
    }
    H[0] += a; H[1] += b2; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }

  const update = (bytes: Uint8Array) => {
    length += bytes.length
    let i = 0
    if (filled > 0) {
      const take = Math.min(64 - filled, bytes.length)
      block.set(bytes.subarray(0, take), filled)
      filled += take
      i = take
      if (filled < 64) return
      compress(block, 0)
      filled = 0
    }
    for (; i + 64 <= bytes.length; i += 64) compress(bytes, i)
    block.set(bytes.subarray(i), 0)
    filled = bytes.length - i
  }

  const hex = () => {
    const bits = length * 8
    const pad = new Uint8Array((filled < 56 ? 64 : 128) - filled)
    pad[0] = 0x80
    const end = pad.length - 8
    // A JS number holds the bit length exactly far past any file size (2^53).
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0
    pad[end] = hi >>> 24; pad[end + 1] = hi >>> 16; pad[end + 2] = hi >>> 8; pad[end + 3] = hi
    pad[end + 4] = lo >>> 24; pad[end + 5] = lo >>> 16; pad[end + 6] = lo >>> 8; pad[end + 7] = lo
    update(pad)
    return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('')
  }

  return { update, hex }
}
