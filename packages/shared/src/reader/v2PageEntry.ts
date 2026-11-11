/**
 * The V2 reader page's entry (`store.mjs`) against what a host holds for its book (#1226): the entry built for
 * `restore`, and the changes a `store` makes. Pure: the Android local library (SQLite rows) and the web host
 * (the server's rows, online) both map through this, so a highlight is matched, re-keyed and tombstoned the
 * same way on both.
 */
import { codePoints, isUuid, sameJson, type PageHighlight, type PagePosition } from './v2LocalSync'

/** `store.mjs` STORE_VERSION: an entry of another version is not restored (asserted equal in mobile's tests). */
export const PAGE_ENTRY_VERSION = 1

export interface PageEntryBook { sha256: string; size: number; name: string }

export interface PageEntry {
  v: number
  book: PageEntryBook
  position: PagePosition | null
  highlights: PageHighlight[]
}

/** The entry `restore` takes: the position and highlights of THIS file version only (the caller filters). */
export const pageEntry = (book: PageEntryBook, position: PagePosition | null, highlights: PageHighlight[]): PageEntry =>
  ({ v: PAGE_ENTRY_VERSION, book, position, highlights })

/** An old (#1078-less) highlight: `quote` held the whole selection; now `selectedText` does and `quote` is its start. */
export function normalisedHighlight(h: PageHighlight): PageHighlight {
  return h.selectedText === undefined ? { ...h, selectedText: h.quote, quote: codePoints(h.quote, 64) } : h
}

/** A highlight's identity for the twin lookup: where it is and what it says. */
const twinKey = (h: PageHighlight | null) => (h ? `${h.cfi}\u0000${h.selectedText ?? h.quote}` : '')

/** A highlight the host holds: its last saved page form (null: unreadable) and whether it is tombstoned. */
export interface HeldHighlight { id: string; highlight: PageHighlight | null; deleted: boolean }

export interface EntryChanges {
  /** The entry's position when it differs from the held one; null when unchanged or absent. */
  position: PagePosition | null
  /** Highlights to save, normalised, under the id they are saved by; `isNew`: nothing held under that id. */
  highlights: { highlight: PageHighlight; isNew: boolean }[]
}

/**
 * What a `store` changes. A highlight new or changed is saved; a tombstoned one stays deleted (a tombstone
 * wins over every edit). One under an id the host does not hold — a pre-#1078 `h…` id, or one re-keyed after
 * `id_conflict` while the page still holds the old one — is the live highlight at the same CFI with the same
 * text when there is one (skipped), else saved, under a new v4 id when its own is not one.
 */
export function entryChanges(
  held: { position: PagePosition | null; highlights: HeldHighlight[] },
  entry: { position: PagePosition | null; highlights: PageHighlight[] },
  newId: () => string,
): EntryChanges {
  const position = entry.position && !sameJson(held.position, entry.position) ? entry.position : null
  const byId = new Map(held.highlights.map((r) => [r.id, r]))
  const live = new Set(held.highlights.filter((r) => !r.deleted).map((r) => twinKey(r.highlight)))
  const highlights: EntryChanges['highlights'] = []
  for (const raw of entry.highlights) {
    let h = normalisedHighlight(raw)
    const row = isUuid(h.id) ? byId.get(h.id) : undefined
    if (!row) {
      if (live.has(twinKey(h))) continue
      if (!isUuid(h.id)) h = { ...h, id: newId() }
    }
    if (row?.deleted) continue
    if (row && sameJson(row.highlight, h)) continue
    if (!row) {
      // Held from here on: the same highlight twice in one entry is one save.
      byId.set(h.id, { id: h.id, highlight: h, deleted: false })
      live.add(twinKey(h))
    }
    highlights.push({ highlight: h, isNew: !row })
  }
  return { position, highlights }
}
