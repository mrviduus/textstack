import { fontFamilyCss, readSettings } from './settings.mjs'
const codeFonts = new WeakMap()

/** A font chosen in the reader wins over the publisher's text fonts, retaining emphasis and code faces. */
export function applyFontFamily(doc, raw) {
  const family = fontFamilyCss(raw)
  const dyslexic = readSettings(raw).fontFamily === 'dyslexic'
  for (const el of doc.querySelectorAll('body, body *')) {
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || el.closest('svg, math')) continue
    if (el.closest('pre, code, kbd, samp')) {
      if (!dyslexic) {
        const original = codeFonts.get(el)
        if (original) {
          if (original.value) el.style.setProperty('font-family', original.value, original.priority)
          else el.style.removeProperty('font-family')
          codeFonts.delete(el)
        }
        continue
      }
      if (!codeFonts.has(el)) codeFonts.set(el, { value: el.style.getPropertyValue('font-family'), priority: el.style.getPropertyPriority('font-family') })
    }
    el.style.setProperty('font-family', family, 'important')
  }
}
