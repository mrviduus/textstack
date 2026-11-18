// #1426: a book's details and cover, read in the page (`describe` → `described`), and the hosts' reader of the answer.
// The page renders untrusted books, so a host takes only what `readDescribed` returns. `bookMeta` needs DOMParser and
// `coverJpeg` a canvas: page only. Bundled (it imports packages/shared), as selection.mjs is.
import { clip } from '../../shared/src/reader/textAnchor'

export const MAX_META_TITLE = 500
export const MAX_META_AUTHOR = 500
export const MAX_META_LANG = 35
export const MAX_META_DESCRIPTION = 4000
/** The cover's long side, px. */
export const COVER_SIDE = 800
/** The page sends a cover only up to this many data-URL characters (tried at q0.85, then q0.6). */
export const MAX_COVER_SENT = 1.5 * 1024 * 1024
/** What a host takes: the decoded JPEG at most the server's cover cap (SyncLimits.MaxCoverBytes). */
export const MAX_COVER_BYTES = 2 * 1024 * 1024
const JPEG_PREFIX = 'data:image/jpeg;base64,'

/** A host's request id, as `chapterText`'s: a string of 1 to 64 characters. */
export const isRequestId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 64

const primary = (tag) => String(tag ?? '').split(/[-_]/)[0].toLowerCase()
const oneLine = (s, max) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), max)

/** A string, or a language map's value in the UI language (by primary subtag), else its first. */
function pick(v, ui) {
  if (typeof v === 'string') return v
  if (!v || typeof v !== 'object') return ''
  const keys = Object.keys(v)
  const key = keys.find((k) => primary(k) === primary(ui)) ?? keys[0]
  return typeof v[key] === 'string' ? v[key] : ''
}

/** HTML as plain text: parsed inert (DOMParser runs no script, loads nothing), blocks on their own lines. */
function htmlText(html) {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  body.querySelectorAll('script,style,template').forEach((e) => e.remove())
  body.querySelectorAll('p,div,br,li,h1,h2,h3,h4,h5,h6,blockquote,tr').forEach((e) => e.after('\n'))
  return body.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

/**
 * foliate's `book.metadata` as `{ title, author, lang, description }`, each a string ('' if missing). Every author,
 * joined with ", "; the language's primary subtag (`en`, not `en-US`); the description as plain text.
 */
export function bookMeta(m, ui = '') {
  const authors = [].concat(m?.author ?? []).map((a) => oneLine(pick(a && typeof a === 'object' ? a.name : a, ui), MAX_META_AUTHOR)).filter(Boolean)
  const lang = primary([].concat(m?.language ?? [])[0])
  const description = pick(m?.description, ui)
  return {
    title: oneLine(pick(m?.title, ui), MAX_META_TITLE),
    author: clip(authors.join(', '), MAX_META_AUTHOR),
    lang: /^[a-z]{2,8}$/.test(lang) ? lang : '',
    description: description ? clip(htmlText(description), MAX_META_DESCRIPTION) : '',
  }
}

/**
 * A cover image blob as a JPEG data URL, long side at most COVER_SIDE, or null (none, not decodable, too big).
 * createImageBitmap: a blob's pixels are never cross-origin, so the canvas stays readable; an SVG cover is not decoded.
 */
export async function coverJpeg(blob) {
  if (!blob) return null
  const img = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, COVER_SIDE / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    const g = canvas.getContext('2d')
    g.fillStyle = '#fff'   // JPEG has no alpha: a transparent cover on white, not black
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const q of [0.85, 0.6]) {
      const url = canvas.toDataURL('image/jpeg', q)
      if (url.startsWith(JPEG_PREFIX) && url.length <= MAX_COVER_SENT) return url
    }
    return null
  } finally {
    img.close()
  }
}

const str = (s, max) => typeof s === 'string' && s.length <= max
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const isCover = (c) => {
  if (typeof c !== 'string' || !c.startsWith(JPEG_PREFIX)) return false
  const b64 = c.slice(JPEG_PREFIX.length)
  if (b64.length % 4 || b64.length > (MAX_COVER_BYTES / 3) * 4 + 4 || !BASE64.test(b64)) return false
  return (b64.length / 4) * 3 - (b64.length - b64.replace(/=+$/, '').length) <= MAX_COVER_BYTES
}

/**
 * A host's read of `described`: `{ id, meta, cover, error? }` fresh, or null for anything the page would not send
 * (another type, a bad id, a field over its cap or of the wrong kind, a cover that is not a base64 JPEG data URL of at
 * most MAX_COVER_BYTES). `meta` is null with an `error`; `cover` null when the book has none.
 */
export function readDescribed(m) {
  if (!m || typeof m !== 'object' || m.type !== 'described' || !isRequestId(m.id)) return null
  if (m.error !== undefined) return str(m.error, 200) ? { id: m.id, meta: null, cover: null, error: m.error } : null
  const { meta, cover } = m
  if (!meta || typeof meta !== 'object') return null
  const { title, author, lang, description } = meta
  if (!str(title, MAX_META_TITLE) || !str(author, MAX_META_AUTHOR) || !str(lang, MAX_META_LANG) || !str(description, MAX_META_DESCRIPTION)) return null
  if (cover !== null && !isCover(cover)) return null
  return { id: m.id, meta: { title, author, lang, description }, cover }
}
