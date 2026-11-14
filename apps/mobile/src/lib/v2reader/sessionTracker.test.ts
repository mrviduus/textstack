import { describe, expect, it } from 'vitest'
import { readRelocate } from './chrome.mjs'
import { createSessionTracker } from './sessionTracker.mjs'

const T0 = Date.parse('2026-11-14T10:00:00Z')
const at = (s: number) => T0 + s * 1000
const iso = (s: number) => new Date(at(s)).toISOString()
/** A page `relocate` through the host's reader. */
const rel = (fraction: number, moved: boolean, words: number | null = 100_000) =>
  readRelocate({ type: 'relocate', index: 1, sections: 9, fraction, cfi: 'epubcfi(/6/2!/4/2)', moved, words })

/** An open of book `b` whose restore landed at `fraction` (not the reader's move). */
function opened(b: string | null = 'b1', fraction = 0.1) {
  const t = createSessionTracker()
  t.open(at(0))
  t.relocate(rel(fraction, false), at(0))
  t.bind(b, at(0))
  return t
}

describe('sessionTracker', () => {
  it('end_TurnsThenLeave_TimeWordsAndPlaces', () => {
    const t = opened()
    // The first turn starts the session: no counted time behind it, so its page is neither time nor words.
    t.relocate(rel(0.101, true), at(60))
    t.relocate(rel(0.102, true), at(120)) // 0.001 × 100 000 = 100 words in 60 s
    t.relocate(rel(0.104, true), at(180)) // 200 words
    expect(t.end(at(210))).toEqual({
      book: 'b1', startedAt: iso(60), endedAt: iso(210), durationSeconds: 150, wordsRead: 300, startPercent: 0.1, endPercent: 0.104,
    })
  })

  it('end_OpenAndRestoreOnly_None', () => {
    const t = opened()
    expect(t.end(at(600))).toBeNull()
  })

  it('end_UnderTenSeconds_None', () => {
    const t = opened()
    t.relocate(rel(0.101, true), at(1))
    expect(t.end(at(9))).toBeNull()
  })

  it('tick_FiveMinutesIdle_EndsWithThreeMinutesCounted_NextActivityStartsAnother', () => {
    const t = opened()
    t.activity(at(0))
    expect(t.tick(at(299))).toBeNull()
    expect(t.tick(at(300))).toMatchObject({ durationSeconds: 180, endedAt: iso(300) })
    t.activity(at(400))
    expect(t.end(at(430))).toMatchObject({ startedAt: iso(400), durationSeconds: 30 })
  })

  it('end_GapOverThreeMinutes_CountsThreeMinutes', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(250))
    expect(t.end(at(260))?.durationSeconds).toBe(190)
  })

  it('end_ClockSetBack_NeverSubtractsNorEndsBeforeItStarted', () => {
    const t = opened()
    t.activity(at(100))
    t.activity(at(130))
    t.activity(at(50))
    expect(t.end(at(40))).toBeNull() // span 0: nothing to send
    const u = opened()
    u.activity(at(0))
    u.activity(at(60))
    u.activity(at(30))
    expect(u.end(at(70))).toMatchObject({ durationSeconds: 70, startedAt: iso(0), endedAt: iso(70) })
    // Set back 90 s mid-session: that step counts nothing, the rest as usual (100 + 0 + 180).
    const v = opened()
    v.activity(at(0))
    v.activity(at(100))
    v.activity(at(10))
    expect(v.end(at(300))?.durationSeconds).toBe(280)
  })

  it('end_OverFourHours_TimeCappedAndWordsScaledToThePaceRead', () => {
    const t = opened()
    // 8 h at 200 wpm: a page of 200 words a minute.
    for (let m = 1; m <= 480; m++) t.relocate(rel(0.1 + m * 0.001, true, 200_000), at(m * 60))
    // The first turn started the session: 479 counted minutes, 95 800 words.
    expect(t.end(at(480 * 60))).toMatchObject({ durationSeconds: 14_400, wordsRead: Math.round((95_800 * 14_400) / (479 * 60)) })
  })

  it('relocate_NotTheReadersMove_NoWordsAndTheNextTurnCountsFromThere', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(30)) // 30 s counted: a step could take 400 words
    t.relocate(rel(0.5, false), at(30)) // a sync move
    t.relocate(rel(0.501, true), at(60)) // 100 words
    expect(t.end(at(60))).toMatchObject({ wordsRead: 100, startPercent: 0.1, endPercent: 0.501 })
  })

  it('relocate_NotTheReadersMoveBack_TurnsFromTheLandingCount', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.3, true), at(60)) // up to 800 words in 60 s
    t.relocate(rel(0.2, false), at(60)) // a sync move or a restore, back
    t.relocate(rel(0.201, true), at(120)) // 100 words, under the old furthest place
    expect(t.end(at(120))?.wordsRead).toBe(900)
  })

  it('relocate_OwnBackThenForward_GroundCountedOnceThenWhatLiesPast', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.102, true), at(60)) // 200 words
    t.relocate(rel(0.101, true), at(90)) // back
    t.relocate(rel(0.102, true), at(120)) // the same ground again: nothing
    t.relocate(rel(0.1025, true), at(150)) // 50 words past the furthest
    expect(t.end(at(150))?.wordsRead).toBe(250)
    const u = opened()
    u.activity(at(0))
    u.relocate(rel(0.102, true), at(60)) // 200 words
    u.relocate(rel(0.1, true), at(90)) // back: takes nothing away either
    expect(u.end(at(90))?.wordsRead).toBe(200)
  })

  it('relocate_LongMovedStep_AtMost800WpmOfCountedTime', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.relocate(rel(0.6, true), at(75)) // 15 s at 800 wpm = 200 words
    expect(t.end(at(80))?.wordsRead).toBe(300)
  })

  it('relocate_LongMoveAfterTwoHoursIdle_ThreeMinutesWorth_NewSessionNone', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.relocate(rel(0.6, true), at(60 + 7200)) // at most 3 min counted: 2400 words
    expect(t.end(at(60 + 7200))?.wordsRead).toBe(2500)
    const u = opened()
    u.activity(at(0))
    expect(u.tick(at(300))).not.toBeNull() // idle: ended
    u.relocate(rel(0.6, true), at(7200)) // starts the next session: nothing counted behind it
    expect(u.end(at(7230))?.wordsRead).toBe(0)
  })

  it('jump_GoThereTwoHoursLater_LandingCountsNothingNextTurnCounts', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.jump(at(60 + 7200)) // 2 h later: "Go there", 20 % on
    t.relocate(rel(0.301, true), at(60 + 7200.2))
    t.relocate(rel(0.3012, true), at(60 + 7200.7)) // the same landing, relocated again
    t.relocate(rel(0.3022, true), at(60 + 7260)) // the next turn: 100 words
    expect(t.end(at(60 + 7260))).toMatchObject({ wordsRead: 200, endPercent: 0.3022 })
  })

  it('jump_BackToAnEarlierChapter_TurnsThereCount', () => {
    const t = opened('b1', 0.5)
    t.activity(at(0))
    t.relocate(rel(0.501, true), at(60)) // 100 words
    t.jump(at(60))
    t.relocate(rel(0.2, true), at(60.2)) // the landing, far behind the furthest place
    t.relocate(rel(0.201, true), at(120)) // 100 words
    t.relocate(rel(0.202, true), at(180)) // 100 words
    expect(t.end(at(180))?.wordsRead).toBe(300)
  })

  it('jump_TimeBeforeIt_FundsNoLongMoveAfter', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.jump(at(240)) // 3 min of reading behind it
    t.relocate(rel(0.3, true), at(240.5)) // the landing
    t.relocate(rel(0.6, true), at(255.5)) // a followed link: 15 s at 800 wpm = 200 words
    expect(t.end(at(256))?.wordsRead).toBe(300)
  })

  it('jump_NoRelocateWithinTheGrace_TheAskExpiresAndTheReadersTurnsCount', () => {
    const t = opened()
    t.activity(at(0))
    t.jump(at(30)) // a target already on screen: no relocate
    t.relocate(rel(0.101, true), at(60)) // the reader's own turn: 100 words
    expect(t.end(at(60))?.wordsRead).toBe(100)
  })

  it('jump_ClockSetBackAfterTheLanding_LaterTurnsCount', () => {
    const t = opened()
    t.activity(at(0))
    t.jump(at(100))
    t.relocate(rel(0.2, true), at(100)) // the landing
    t.activity(at(160)) // a minute read there
    // The clock set back past the landing: the reader's own turn still, 0.0008 × 100 000 = 80 words.
    t.relocate(rel(0.2008, true), at(99.5))
    expect(t.end(at(161))?.wordsRead).toBe(80)
  })

  it('jump_StartsTheSessionWithNoPlace_LandingIsTheStartAndTheNextTurnCounts', () => {
    const t = createSessionTracker()
    t.open(at(0))
    t.bind('b1', at(0))
    t.jump(at(0)) // a contents entry before any relocate: the session starts with no place
    t.relocate(rel(0.4, true), at(0.3)) // the landing
    t.relocate(rel(0.401, true), at(60)) // 100 words
    expect(t.end(at(60))).toMatchObject({ wordsRead: 100, startPercent: 0.4, endPercent: 0.401 })
  })

  it('relocate_CbzOrPdfWithoutWords_TimeOnly', () => {
    const t = opened()
    t.relocate(rel(0.2, true, null), at(30))
    t.relocate(rel(0.3, true, null), at(60))
    expect(t.end(at(60))).toMatchObject({ durationSeconds: 30, wordsRead: 0, endPercent: 0.3 })
  })

  it('bind_NullBook_NoSession', () => {
    const t = opened(null)
    t.relocate(rel(0.2, true), at(30))
    expect(t.end(at(60))).toBeNull()
  })

  it('open_AnotherBook_EndsTheFirstAndNothingOfItCountsToTheNext', () => {
    const t = opened('b1')
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(30))
    expect(t.open(at(60))).toMatchObject({ book: 'b1', wordsRead: 100, endPercent: 0.101 })
    // The next book's first relocate comes before its `opened`: it is the baseline, its own.
    t.relocate(rel(0.7, false), at(61))
    t.relocate(rel(0.75, true), at(62)) // before bind: no session
    t.bind('b2', at(63))
    t.activity(at(63))
    t.relocate(rel(0.7505, true), at(123)) // 50 words
    expect(t.end(at(150))).toMatchObject({ book: 'b2', startedAt: iso(63), wordsRead: 50, startPercent: 0.75, endPercent: 0.7505 })
  })

  it('open_ThenFirstMoveOfTheNextBook_ThePlaceBeforeIsNoBaseline', () => {
    const t = opened('b1')
    t.relocate(rel(0.101, true), at(30))
    t.open(at(60))
    t.bind('b2', at(61))
    t.activity(at(61))
    t.relocate(rel(0.75, true), at(121))
    expect(t.end(at(150))).toMatchObject({ book: 'b2', wordsRead: 0, startPercent: 0.75 })
  })

  it('bind_AnotherBook_EndsTheSessionBefore', () => {
    const t = opened('b1')
    t.relocate(rel(0.101, true), at(30))
    expect(t.bind('b2', at(60))).toMatchObject({ book: 'b1', durationSeconds: 30 })
    expect(t.bind('b2', at(61))).toBeNull()
  })
})
