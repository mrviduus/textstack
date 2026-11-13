// The book's table of contents for the reader chrome (#1261): the hosts' read of `opened.toc` and the entries
// around the reader's place. Pure: the page renders untrusted book content, so a host shows only what these return.

/** Entries past this place in the page's list are not taken (a host renders every one it takes). */
export const MAX_TOC_ENTRIES = 5000
/** Nesting deeper than this is drawn at this level. */
export const MAX_TOC_DEPTH = 6
const MAX_TOC_LABEL = 200
const MAX_TOC_HREF = 2048

/**
 * A host's read of `opened.toc` (never throws): `[{ index, label, href, depth }]` in reading order. `index` is the
 * entry's place in the page's list, the one `relocate.tocIndex` names, so a dropped entry never renumbers the
 * others. Dropped: not an object, no label (a string, trimmed, cut to 200), no href (a string of 1 to 2048). `depth`:
 * a whole number from 0 to 6 (deeper is 6), anything else 0.
 */
export function readToc(m) {
  const list = Array.isArray(m?.toc) ? m.toc : []
  const out = []
  for (let index = 0; index < list.length && index < MAX_TOC_ENTRIES; index++) {
    const e = list[index]
    const label = typeof e?.label === 'string' ? e.label.trim().slice(0, MAX_TOC_LABEL) : ''
    if (!label || typeof e.href !== 'string' || !e.href || e.href.length > MAX_TOC_HREF) continue
    out.push({ index, label, href: e.href, depth: Number.isInteger(e.depth) && e.depth > 0 ? Math.min(e.depth, MAX_TOC_DEPTH) : 0 })
  }
  return out
}

/**
 * The entries around the reader's place, of `readToc`'s list: `current` is the entry `tocIndex` names (null: none,
 * or that entry was dropped), `prev` and `next` the nearest entries before and after that place. A `tocIndex` that
 * is no whole number (null: before the first entry) has no `prev` and the first entry as `next`.
 */
export function tocAround(toc, tocIndex) {
  const at = Number.isInteger(tocIndex) ? tocIndex : -1
  let prev = null
  let current = null
  let next = null
  for (const e of toc) {
    if (e.index < at) prev = e
    else if (e.index === at) current = e
    else {
      next = e
      break
    }
  }
  return { prev, current, next }
}
