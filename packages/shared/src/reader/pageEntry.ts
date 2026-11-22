/**
 * The V2 reader page's entry (`store.mjs`) against what a host holds for its book (#1226): the entry built for
 * `restore`, and the changes a `store` makes. Pure: the Android local library (SQLite rows) and the web host
 * (the server's rows, online) both map through this, so a highlight is matched, re-keyed and tombstoned the
 * same way on both.
 */
import { codePoints, isUuid, sameJson, type PageHighlight, type PagePosition } from './localSync'
import { emptyEntry, isBookmark, type PageEntry, type PageEntryBook, type PageQuotation } from './pageStore'

/** The entry `restore` takes: the position, highlights and quotations (#1195) of THIS file version only (the caller filters). */
export const pageEntry = (book: PageEntryBook, position: PagePosition | null, highlights: PageHighlight[], quotations: PageQuotation[] = []): PageEntry =>
  ({ ...emptyEntry(book), position, highlights, ...(quotations.length ? { quotations } : {}) })

/** An old (#1078-less) highlight: `quote` held the whole selection; now `selectedText` does and `quote` is its start. */
export function normalisedHighlight<H extends PageHighlight>(h: H): H {
  return h.selectedText === undefined ? { ...h, selectedText: h.quote, quote: codePoints(h.quote, 64) } : h
}

/** A highlight's identity for the twin lookup: where it is, what it says, and whether it is a bookmark (#1314: one over a highlight's exact range is not its twin). */
const twinKey = (h: PageHighlight | null) => (h ? `${h.cfi}\u0000${h.selectedText ?? h.quote}\u0000${isBookmark(h)}` : '')

/**
 * A highlight the host holds: its last saved page form (null: unreadable), its file version, whether it is tombstoned.
 * `H`: the form a host diffs (the web session's carries its note, #1312), the same type on both sides.
 */
export interface HeldHighlight<H extends PageHighlight = PageHighlight> { id: string; highlight: H | null; fileId: string | null; deleted: boolean }

export interface EntryChanges<H extends PageHighlight = PageHighlight> {
  /** The entry's position when it differs from the held one; null when unchanged or absent. */
  position: PagePosition | null
  /** Highlights to save, normalised, under the id they are saved by; `isNew`: nothing held under that id. */
  highlights: { highlight: H; isNew: boolean }[]
  /**
   * The page ids skipped as the twin of a live held row (#1314 review): `from` the page's id, `to` the row's. The host
   * records them in its one old→new map (as an `id_conflict` re-key), so a removal, a note or a jump under the page's
   * id reaches the row the server holds.
   */
  aliases: { from: string; to: string }[]
}

/**
 * What a `store` changes. A highlight new or changed is saved; a tombstoned one stays deleted (a tombstone
 * wins over every edit). One under an id the host does not hold — a pre-#1078 `h…` id, or one re-keyed after
 * `id_conflict` while the page still holds the old one — is the live highlight at the same CFI with the same
 * text IN THIS FILE VERSION when there is one (skipped, and named in `aliases`; a CFI means nothing in another
 * version), else saved, under a new v4 id when its own is not one. `fileId`: the file version the entry is for.
 */
export function entryChanges<H extends PageHighlight = PageHighlight>(
  fileId: string | null,
  held: { position: PagePosition | null; highlights: HeldHighlight<H>[] },
  entry: { position: PagePosition | null; highlights: H[] },
  newId: () => string,
): EntryChanges<H> {
  const position = entry.position && !sameJson(held.position, entry.position) ? entry.position : null
  const byId = new Map(held.highlights.map((r) => [r.id, r]))
  /** Twin key → the id of the live held row with it. */
  const live = new Map(held.highlights.filter((r) => !r.deleted && r.fileId === fileId).map((r) => [twinKey(r.highlight), r.id]))
  const highlights: EntryChanges<H>['highlights'] = []
  const aliases: EntryChanges<H>['aliases'] = []
  for (const raw of entry.highlights) {
    let h = normalisedHighlight(raw)
    const row = isUuid(h.id) ? byId.get(h.id) : undefined
    if (!row) {
      const twin = live.get(twinKey(h))
      if (twin !== undefined) {
        aliases.push({ from: raw.id, to: twin })
        continue
      }
      if (!isUuid(h.id)) h = { ...h, id: newId() }
    }
    if (row?.deleted) continue
    if (row && sameJson(row.highlight, h)) continue
    if (!row) {
      // Held from here on: the same highlight twice in one entry is one save.
      byId.set(h.id, { id: h.id, highlight: h, fileId, deleted: false })
      live.set(twinKey(h), h.id)
    }
    highlights.push({ highlight: h, isNew: !row })
  }
  return { position, highlights, aliases }
}
