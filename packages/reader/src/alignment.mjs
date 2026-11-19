import { readSettings } from './settings.mjs'

const BLOCKS = 'body, p, li, blockquote, dd, dt, div, section, article, td, th, figcaption'
const ALIGN = { left: 'start', center: 'center', justify: 'justify' }
const originals = new WeakMap()

/** Explicit reader alignment wins over publisher classes and inline !important; `book` restores them. */
export function applyAlignment(doc, textAlign) {
  const chosen = readSettings({ textAlign }).textAlign
  let saved = originals.get(doc)
  if (chosen === 'book') {
    if (!saved) return
    for (const [el, { value, priority }] of saved) {
      if (value) el.style.setProperty('text-align', value, priority)
      else el.style.removeProperty('text-align')
    }
    originals.delete(doc)
    return
  }
  if (!saved) originals.set(doc, saved = new Map())
  for (const el of doc.querySelectorAll(BLOCKS)) {
    if (!saved.has(el)) saved.set(el, {
      value: el.style.getPropertyValue('text-align'),
      priority: el.style.getPropertyPriority('text-align'),
    })
    el.style.setProperty('text-align', ALIGN[chosen], 'important')
  }
}
