import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readerFontFaceCss } from './readerFonts.generated'
import { buildEngineReaderHtml } from './readerHtml'
import { fontFaceKey } from './readerChrome'

const styles = ['Regular', 'Italic', 'Bold', 'BoldItalic']

describe('offline reader fonts', () => {
  it('embeds the same valid TextStack bytes on web, native and WebView', () => {
    for (const style of styles) {
      const native = readFileSync(resolve(__dirname, `../../assets/fonts/TextStack-${style}.ttf`))
      const web = readFileSync(resolve(__dirname, `../../../web/public/fonts/TextStack-${style}.ttf`))
      expect(native.readUInt32BE(0)).toBe(0x00010000)
      expect(native.equals(web)).toBe(true)
      expect(readerFontFaceCss).toContain(native.toString('base64'))
    }
  })

  it('embeds Source Sans 3 and both families when either standard font is selected', () => {
    const sans = readFileSync(resolve(__dirname, '../../assets/fonts/SourceSans3-Regular.ttf'))
    expect(sans.readUInt32BE(0)).toBe(0x00010000)
    expect(readerFontFaceCss).toContain(sans.toString('base64'))
    for (const family of ['"TextStack", serif', '"Source Sans 3", sans-serif', 'OpenDyslexic, sans-serif']) {
      expect(buildEngineReaderHtml('<p>Offline text</p>', {
        fontFamily: family, fontSize: 20, lineHeight: 1.6, textAlign: 'left',
        backgroundColor: '#ffffff', textColor: '#111827',
      })).toContain(readerFontFaceCss)
    }
  })

  it('keeps standard font switching out of document identity', () => {
    expect(fontFaceKey('"TextStack", serif')).toBe(fontFaceKey('"Source Sans 3", sans-serif'))
    expect(fontFaceKey('OpenDyslexic, sans-serif')).toBe('dyslexic')
  })
})
