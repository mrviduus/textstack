// Reading settings (#1260): pure, the page and both hosts. The host is trusted, but these values end up in CSS
// injected into book documents, so everything is read through `readChosen`: closed lists and one clamped integer.
// No string from outside ever reaches `settingsCss`.

/** px; the panel steps by FONT_STEP. */
export const FONT_MIN = 14
export const FONT_MAX = 28
export const FONT_STEP = 2
export const LINE_HEIGHTS = [1.5, 1.6, 1.65, 1.8]
export const FAMILIES = ['serif', 'sans', 'dyslexic']
export const ALIGNS = ['left', 'center', 'justify']
/** Page background and text per theme; the hosts' bars use the same colours. */
export const THEMES = {
  light: { bg: '#ffffff', fg: '#1a1a1a' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  dark: { bg: '#1a1a1a', fg: '#e0e0e0' },
}
export const DEFAULTS = Object.freeze({ fontSize: 20, lineHeight: 1.6, fontFamily: 'serif', textAlign: 'center', theme: 'light' })
/** Where each host keeps the reader's choices (localStorage / AsyncStorage), as JSON. */
export const SETTINGS_KEY = 'v2reader.settings'

const VALID = {
  fontSize: (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v))) : undefined),
  lineHeight: (v) => (LINE_HEIGHTS.includes(v) ? v : undefined),
  fontFamily: (v) => (FAMILIES.includes(v) ? v : undefined),
  textAlign: (v) => (ALIGNS.includes(v) ? v : undefined),
  theme: (v) => (Object.hasOwn(THEMES, v) ? v : undefined),
}

/**
 * The valid choices in `raw`, nothing else: an unknown key, a value off its list or of the wrong type is dropped
 * (an older shape, a damaged store). What a host stores: only what the reader chose, so a changed default still
 * reaches whoever never chose.
 */
export function readChosen(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(VALID)) {
    const v = Object.hasOwn(raw, k) ? VALID[k](raw[k]) : undefined
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Whole, valid settings from anything: the defaults under the valid choices. */
export const readSettings = (raw) => ({ ...DEFAULTS, ...readChosen(raw) })

/** A stored value (JSON, or null) as choices; malformed is none. */
export function parseChosen(json) {
  try { return readChosen(JSON.parse(json)) } catch { return {} }
}

/** The reader changed something: the choices to store. A value off its list changes nothing. */
export const choose = (chosen, patch) => ({ ...readChosen(chosen), ...readChosen(patch) })

const FAMILY_CSS = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  dyslexic: '"TextStack OpenDyslexic", sans-serif',
}
/** `start`, not `left`: a right-to-left book's own side. */
const ALIGN_CSS = { left: 'start', center: 'center', justify: 'justify' }

/**
 * The stylesheet for a book section. `raw` goes through `readSettings` again here. `fontUrl`: the page's own blob:
 * URL of OpenDyslexic, used only for that family and only if it is one. A book's own rules on an element still
 * win over the base font and colours, except: text blocks take the alignment and line height, OpenDyslexic
 * replaces every font (it is an accessibility setting), and dark recolours everything (black text would vanish).
 */
export function settingsCss(raw, fontUrl) {
  const s = readSettings(raw)
  const { bg, fg } = THEMES[s.theme]
  const dyslexic = s.fontFamily === 'dyslexic'
  const face = dyslexic && typeof fontUrl === 'string' && /^blob:[\w:/.-]+$/.test(fontUrl)
    ? `@font-face { font-family: "TextStack OpenDyslexic"; src: url(${fontUrl}) format("woff2"); }\n` : ''
  return `${face}html, body { font-size: ${s.fontSize}px !important; line-height: ${s.lineHeight} !important; font-family: ${FAMILY_CSS[s.fontFamily]} !important; color: ${fg} !important; background: ${bg} !important; }
p, li, blockquote, dd { text-align: ${ALIGN_CSS[s.textAlign]} !important; line-height: inherit !important; }${
    dyslexic ? '\nbody * { font-family: inherit !important; }' : ''}${
    s.theme === 'dark' ? '\nbody * { color: inherit !important; background-color: transparent !important; }\na:any-link { color: #8ab4f8 !important; }' : ''}`
}
