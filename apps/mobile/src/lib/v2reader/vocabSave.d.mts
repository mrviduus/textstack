// Types for vocabSave.mjs (apps/web type-checks it without allowJs); a change to one must update the other.

/** The fields of a save's response the outcome reads (web `SaveWordResponse`, shared `SaveWordResponseDto`). */
export interface V2SaveResponse<W extends { id: string } = { id: string }> {
  outcome: string
  word: W | null
  lookupId?: string | null
  tapsRemaining?: number | null
}
export type V2SaveOutcome<W> =
  | { kind: 'saved'; word: W }
  | { kind: 'already_saved'; word: W | null }
  | { kind: 'deleted'; id: string }
  | { kind: 'pending' }
  | { kind: 'lookup'; lookup: 'lookup' | 'lookup_pending'; id: string; tapsRemaining: number | null }
  | { kind: 'none' }
export function saveOutcome<W extends { id: string }>(resp: V2SaveResponse<W> | null | undefined): V2SaveOutcome<W>
export function savesWords(opened: unknown): boolean
