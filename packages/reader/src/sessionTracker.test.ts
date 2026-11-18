import { describe, expect, it } from 'vitest'
import { readRelocate } from './chrome.mjs'
import { createSessionTracker } from './sessionTracker.mjs'

const T0 = Date.parse('2026-11-14T10:00:00Z')
const at = (s: number) => T0 + s * 1000
const iso = (s: number) => new Date(at(s)).toISOString()
/** A page `relocate` through the host's reader. */
const rel = (fraction: number, moved: boolean, cause: string, words: number | null = 100_000) =>
  readRelocate({ type: 'relocate', index: 1, sections: 9, fraction, cfi: 'epubcfi(/6/2!/4/2)', moved, words, cause })
/** The reader's own page turn. */
const turn = (fraction: number, words: number | null = 100_000) => rel(fraction, true, 'turn', words)
/** The landing of a navigation (`moved`: the reader chose it; not: a sync move, a restore). */
const nav = (fraction: number, moved = true) => rel(fraction, moved, 'nav')
/** A re-layout or the same place again. */
const layout = (fraction: number) => rel(fraction, false, 'layout')

/** An open of book `b` whose restore landed at `fraction`. */
function opened(b: string | null = 'b1', fraction = 0.1) {
  const t = createSessionTracker()
  t.open(at(0))
  t.relocate(nav(fraction, false), at(0))
  t.bind(b, at(0))
  return t
}

describe('sessionTracker', () => {
  it('end_TurnsThenLeave_TimeWordsAndPlaces', () => {
    const t = opened()
    // The first turn starts the session: no counted time behind it, so its page is neither time nor words.
    t.relocate(turn(0.101), at(60))
    t.relocate(turn(0.102), at(120)) // 0.001 × 100 000 = 100 words in 60 s
    t.relocate(turn(0.104), at(180)) // 200 words
    expect(t.end(at(210))).toEqual({
      book: 'b1', startedAt: iso(60), endedAt: iso(210), durationSeconds: 150, wordsRead: 300, startPercent: 0.1, endPercent: 0.104,
    })
  })

  it('end_OpenAndRestoreOnly_None', () => {
    expect(opened().end(at(600))).toBeNull()
  })

  it('end_UnderTenSeconds_None', () => {
    const t = opened()
    t.relocate(turn(0.101), at(1))
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
    const v = opened()
    v.activity(at(0))
    v.activity(at(100))
    v.activity(at(10)) // set back 90 s: that step counts nothing, the rest as usual (100 + 0 + 180)
    expect(v.end(at(300))?.durationSeconds).toBe(280)
  })

  it('end_ClockSetBackBelowTheCountedTime_WordsScaledWithTheSeconds', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.105), at(60)) // 500 words in 60 s
    t.activity(at(120)) // 120 s counted
    // The clock set back: the span is 60 s, the seconds sent 60 of the 120 counted, so half the words.
    expect(t.end(at(60))).toMatchObject({ durationSeconds: 60, wordsRead: 250 })
  })

  it('end_OverFourHours_TimeCappedAndWordsScaledToThePaceRead', () => {
    const t = opened()
    // 8 h at 200 wpm: a page of 200 words a minute.
    for (let m = 1; m <= 480; m++) t.relocate(turn(0.1 + m * 0.001, 200_000), at(m * 60))
    // The first turn started the session: 479 counted minutes, 95 800 words.
    expect(t.end(at(480 * 60))).toMatchObject({ durationSeconds: 14_400, wordsRead: Math.round((95_800 * 14_400) / (479 * 60)) })
  })

  it('relocate_Layout_NoWordsTheNextTurnCountsFromThere', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(30)) // 30 s counted: a step could take 400 words
    t.relocate(layout(0.103), at(30))
    t.relocate(turn(0.104), at(60)) // 100 words
    expect(t.end(at(60))).toMatchObject({ wordsRead: 100, startPercent: 0.1, endPercent: 0.104 })
  })

  it('relocate_LayoutWhileBehindTheFurthestPlace_GroundNotCountedAgain', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.103), at(60)) // 300 words
    t.relocate(turn(0.101), at(90)) // back
    t.relocate(layout(0.1012), at(100)) // a re-layout there
    t.relocate(turn(0.102), at(130)) // ground already counted
    t.relocate(turn(0.1035), at(190)) // 50 words past the furthest
    expect(t.end(at(190))?.wordsRead).toBe(350)
  })

  it('relocate_NavBack_TurnsFromTheLandingCount', () => {
    const t = opened('b1', 0.5)
    t.activity(at(0))
    t.relocate(turn(0.501), at(60)) // 100 words
    t.relocate(nav(0.2), at(61)) // a contents entry far back
    t.relocate(turn(0.201), at(120)) // 100 words
    t.relocate(turn(0.202), at(180)) // 100 words
    expect(t.end(at(180))?.wordsRead).toBe(300)
  })

  it('relocate_SyncMoveBack_TurnsFromTheLandingCount', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.3), at(60)) // up to 800 words in 60 s
    t.relocate(nav(0.2, false), at(60)) // another device's place, behind
    t.relocate(turn(0.201), at(120)) // 100 words
    expect(t.end(at(120))?.wordsRead).toBe(900)
  })

  it('relocate_SlowNavLandingTwoSecondsLater_CountsNothing', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.101), at(60)) // 100 words
    t.activity(at(7260)) // 2 h later: "Go there"
    t.relocate(nav(0.301), at(7262)) // lands 2 s later, 20 % on
    t.relocate(nav(0.3012), at(7263)) // the same landing, relocated again
    t.relocate(turn(0.3022), at(7320)) // the next turn: 100 words
    expect(t.end(at(7320))).toMatchObject({ wordsRead: 200, endPercent: 0.3022 })
  })

  it('relocate_ContentsEntryAlreadyOnScreenThenFastTurns_EachTurnCounts', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(30)) // a contents entry on screen: no relocate
    t.relocate(turn(0.1005), at(35)) // 50 words in 5 s (66 allowed)
    t.relocate(turn(0.101), at(40)) // 50 words
    t.relocate(turn(0.1015), at(45)) // 50 words
    expect(t.end(at(45))?.wordsRead).toBe(150)
  })

  it('relocate_SessionStartedWithNoPlace_TurnsAfterTheFirstCountEach', () => {
    const t = createSessionTracker()
    t.open(at(0))
    t.bind('b1', at(0))
    t.activity(at(0)) // no relocate yet: no place
    t.relocate(turn(0.4), at(30)) // where it starts
    t.relocate(turn(0.401), at(60)) // 100 words
    t.relocate(turn(0.402), at(90)) // 100 words
    expect(t.end(at(90))).toMatchObject({ wordsRead: 200, startPercent: 0.4, endPercent: 0.402 })
  })

  it('relocate_OwnBackThenForward_GroundCountedOnceThenWhatLiesPast', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.102), at(60)) // 200 words
    t.relocate(turn(0.101), at(90)) // back
    t.relocate(turn(0.102), at(120)) // the same ground again: nothing
    t.relocate(turn(0.1025), at(150)) // 50 words past the furthest
    expect(t.end(at(150))?.wordsRead).toBe(250)
    const u = opened()
    u.activity(at(0))
    u.relocate(turn(0.102), at(60)) // 200 words
    u.relocate(turn(0.1), at(90)) // back: takes nothing away either
    expect(u.end(at(90))?.wordsRead).toBe(200)
  })

  it('relocate_LongTurn_AtMost800WpmOfCountedTime', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.101), at(60)) // 100 words
    t.relocate(turn(0.6), at(75)) // a long scroll: 15 s at 800 wpm = 200 words
    expect(t.end(at(80))?.wordsRead).toBe(300)
  })

  it('relocate_LongTurnAfterTwoHoursIdle_ThreeMinutesWorth_NewSessionNone', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(turn(0.101), at(60)) // 100 words
    t.relocate(turn(0.6), at(60 + 7200)) // at most 3 min counted: 2400 words
    expect(t.end(at(60 + 7200))?.wordsRead).toBe(2500)
    const u = opened()
    u.activity(at(0))
    expect(u.tick(at(300))).not.toBeNull() // idle: ended
    u.relocate(turn(0.6), at(7200)) // starts the next session: nothing counted behind it
    expect(u.end(at(7230))?.wordsRead).toBe(0)
  })

  it('relocate_TurnsNotMovedByTheSaveRule_NoRestore_ASessionWithWords', () => {
    // The restore never came (the web host's failed read): the page's save rule keeps `moved` false, `cause` says turn.
    const t = createSessionTracker()
    t.open(at(0))
    t.relocate(rel(0.1, false, 'nav'), at(0))
    t.bind('b1', at(0))
    t.relocate(rel(0.101, false, 'turn'), at(30)) // a wheel scroll: starts the session
    t.relocate(rel(0.102, false, 'turn'), at(60)) // 100 words
    t.relocate(rel(0.103, false, 'turn'), at(90)) // 100 words
    expect(t.end(at(90))).toMatchObject({ durationSeconds: 60, wordsRead: 200, startPercent: 0.1, endPercent: 0.103 })
  })

  it('relocate_CbzOrPdfWithoutWords_TimeOnly', () => {
    const t = opened()
    t.relocate(turn(0.2, null), at(30))
    t.relocate(turn(0.3, null), at(60))
    expect(t.end(at(60))).toMatchObject({ durationSeconds: 30, wordsRead: 0, endPercent: 0.3 })
  })

  it('relocate_UnknownCause_LayoutWhichCountsNothing', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.105, true, 'scroll'), at(60))
    expect(t.end(at(60))?.wordsRead).toBe(0)
  })

  it('bind_NullBook_NoSession', () => {
    const t = opened(null)
    t.relocate(turn(0.2), at(30))
    expect(t.end(at(60))).toBeNull()
  })

  it('open_AnotherBook_EndsTheFirstAndNothingOfItCountsToTheNext', () => {
    const t = opened('b1')
    t.activity(at(0))
    t.relocate(turn(0.101), at(30))
    expect(t.open(at(60))).toMatchObject({ book: 'b1', wordsRead: 100, endPercent: 0.101 })
    // The next book's first relocate comes before its `opened`: it is the baseline, its own.
    t.relocate(nav(0.7, false), at(61))
    t.relocate(turn(0.75), at(62)) // before bind: no session
    t.bind('b2', at(63))
    t.activity(at(63))
    t.relocate(turn(0.7505), at(123)) // 50 words
    expect(t.end(at(150))).toMatchObject({ book: 'b2', startedAt: iso(63), wordsRead: 50, startPercent: 0.75, endPercent: 0.7505 })
  })

  it('open_ThenFirstMoveOfTheNextBook_ThePlaceBeforeIsNoBaseline', () => {
    const t = opened('b1')
    t.relocate(turn(0.101), at(30))
    t.open(at(60))
    t.bind('b2', at(61))
    t.activity(at(61))
    t.relocate(turn(0.75), at(121))
    expect(t.end(at(150))).toMatchObject({ book: 'b2', wordsRead: 0, startPercent: 0.75 })
  })

  it('bind_AnotherBook_EndsTheSessionBefore', () => {
    const t = opened('b1')
    t.relocate(turn(0.101), at(30))
    expect(t.bind('b2', at(60))).toMatchObject({ book: 'b1', durationSeconds: 30 })
    expect(t.bind('b2', at(61))).toBeNull()
  })
})
