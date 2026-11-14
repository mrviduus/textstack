import { describe, expect, it } from 'vitest'
import { saveOutcome } from './vocabSave.mjs'

// #1270: what each answer of a vocabulary save shows in the V2 reader (both hosts).

const card = { id: 'w1', word: 'pond', stage: 0 }
const resp = (outcome: string, extra: object = {}) => ({ outcome, word: card, lookupId: null, tapsRemaining: null, ...extra })

describe('saveOutcome', () => {
  it('srs_TheCard', () => {
    expect(saveOutcome(resp('srs'))).toEqual({ kind: 'saved', word: card })
  })

  it('srsWithoutACard_Nothing', () => {
    expect(saveOutcome(resp('srs', { word: null }))).toEqual({ kind: 'none' })
  })

  it('deleted_TheTombstonesId_ForTheRestoreOffer_NeverSaved', () => {
    expect(saveOutcome(resp('deleted'))).toEqual({ kind: 'deleted', id: 'w1' })
  })

  it('deletedWithoutATombstone_Nothing', () => {
    expect(saveOutcome(resp('deleted', { word: null }))).toEqual({ kind: 'none' })
    expect(saveOutcome(resp('deleted', { word: { id: 7 } } as object))).toEqual({ kind: 'none' })
  })

  it('pending_QueuedForTomorrow', () => {
    expect(saveOutcome(resp('pending', { word: null }))).toEqual({ kind: 'pending' })
  })

  it.each(['lookup', 'lookup_pending'])('%s_TheLookupToPromote_WithTheTapsLeft', (outcome) => {
    expect(saveOutcome(resp(outcome, { word: null, lookupId: 'l1', tapsRemaining: 2 })))
      .toEqual({ kind: 'lookup', lookup: outcome, id: 'l1', tapsRemaining: 2 })
    expect(saveOutcome(resp(outcome, { word: null, lookupId: 'l1', tapsRemaining: undefined })))
      .toEqual({ kind: 'lookup', lookup: outcome, id: 'l1', tapsRemaining: null })
  })

  it('lookupWithoutAnId_Nothing', () => {
    expect(saveOutcome(resp('lookup', { word: null }))).toEqual({ kind: 'none' })
  })

  it('alreadySaved_TheCard', () => {
    expect(saveOutcome(resp('already_saved'))).toEqual({ kind: 'already_saved', word: card })
  })

  it('noAnswer_Nothing', () => {
    expect(saveOutcome(null)).toEqual({ kind: 'none' })
    expect(saveOutcome(undefined)).toEqual({ kind: 'none' })
  })
})
