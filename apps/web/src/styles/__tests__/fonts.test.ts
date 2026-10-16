import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// public/fonts/OpenDyslexic-Regular.woff2 spent months being a GitHub HTML page that
// someone had curl'd and saved with a .woff2 extension. reader.css referenced it as a
// real @font-face, so the "Dyslexic" reader font silently fell back to sans-serif —
// no console error, no failed request, nothing to notice. The same bytes were also
// base64-inlined into the mobile reader.
//
// Static assets are invisible to unit tests unless a test goes looking, so this one
// does. Any font added under public/fonts should get a line here.
const FONTS = ['OpenDyslexic-Regular.woff2']
const TRUETYPE_FONTS = ['TextStack-Regular.ttf', 'TextStack-Italic.ttf', 'TextStack-Bold.ttf', 'TextStack-BoldItalic.ttf']

describe('bundled web fonts', () => {
  for (const name of TRUETYPE_FONTS) {
    it(`${name} is a real TrueType font`, () => {
      const bytes = readFileSync(resolve(__dirname, '../../../public/fonts', name))
      expect(bytes.readUInt32BE(0)).toBe(0x00010000)
      expect(bytes.length).toBeGreaterThan(10_000)
    })
  }
  for (const name of FONTS) {
    it(`${name} is a real woff2`, () => {
      const bytes = readFileSync(resolve(__dirname, '../../../public/fonts', name))
      // WOFF2 signature. HTML starts with '<' or whitespace.
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2')
      expect(bytes.length).toBeGreaterThan(10_000)
    })
  }
})
