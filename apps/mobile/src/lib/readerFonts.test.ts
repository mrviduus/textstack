import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readerFontFaceCss } from './readerFonts'
import { buildEngineReaderHtml } from './readerHtml'
import { fontFaceKey } from './readerChrome'

describe('compressed offline reader fonts', () => {
  it('embeds only the chosen family, with four real faces', () => {
    for (const family of ['TextStack', 'Source Sans 3']) {
      const css = readerFontFaceCss(family)
      expect(css.match(/@font-face/g)).toHaveLength(4)
      for (const [weight, style] of [[400, 'normal'], [400, 'italic'], [700, 'normal'], [700, 'italic']]) {
        expect(css).toContain(`font-weight: ${weight}; font-style: ${style};`)
      }
      expect(css).not.toContain(`font-family: '${family === 'TextStack' ? 'Source Sans 3' : 'TextStack'}'`)
    }
    expect(readerFontFaceCss('Georgia, serif')).toBe('')
    expect(readerFontFaceCss('OpenDyslexic')).not.toContain("font-family: 'TextStack'")
  })

  it('generated data matches valid compressed source files', () => {
    for (const [family, files, dir] of [
      ['TextStack', ['Regular', 'Italic', 'Bold', 'BoldItalic'], '../../../web/src/assets/fonts'],
      ['Source Sans 3', ['Regular', 'It', 'Bold', 'BoldIt'], '../../assets/fonts'],
    ] as const) {
      for (const style of files) {
        const name = `${family === 'TextStack' ? 'TextStack' : 'SourceSans3'}-${style}.woff2`
        const bytes = readFileSync(resolve(__dirname, dir, name))
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2')
        expect(readerFontFaceCss(family)).toContain(bytes.toString('base64'))
      }
    }
  })

  it('keeps TextStack document font CSS below 350 KB, versus the old 1.88 MB', () => {
    expect(Buffer.byteLength(readerFontFaceCss('TextStack'))).toBeLessThan(350_000)
    const html = buildEngineReaderHtml('<p>Offline text</p>')
    expect(html).toContain(readerFontFaceCss('TextStack'))
    expect(html).not.toContain("font-family: 'Source Sans 3'")
  })

  it('rebuilds through the restore path when the embedded family changes', () => {
    expect(fontFaceKey('TextStack')).not.toBe(fontFaceKey('Source Sans 3'))
    expect(fontFaceKey('TextStack, Georgia, serif')).toBe(fontFaceKey('TextStack'))
    expect(fontFaceKey('OpenDyslexic')).toBe('dyslexic')
  })
})
