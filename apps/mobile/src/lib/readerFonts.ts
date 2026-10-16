import { readerFontFamilies } from './readerFonts.generated'
import { openDyslexicBase64 } from './openDyslexicBase64'

/** Keep only the selected family in the document; no app-file origin or network needed. */
export function readerFontFaceCss(family: string): string {
  if (family.includes('OpenDyslexic')) {
    return `@font-face { font-family: 'OpenDyslexic'; src: url(data:font/woff2;base64,${openDyslexicBase64}) format('woff2'); font-weight: 400; font-style: normal; }`
  }
  if (family.includes('TextStack')) return readerFontFamilies.TextStack
  if (family.includes('Source Sans 3')) return readerFontFamilies['Source Sans 3']
  return ''
}
