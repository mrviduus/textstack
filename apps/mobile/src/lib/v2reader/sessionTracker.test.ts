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
  it('a session from the first turn to the end: time, the words the turns covered, start and end place', () => {
    const t = opened()
    // The first turn starts the session: no counted time behind it, so its page is neither time nor words.
    t.relocate(rel(0.101, true), at(60))
    t.relocate(rel(0.102, true), at(120)) // 0.001 × 100 000 = 100 words in 60 s
    t.relocate(rel(0.104, true), at(180)) // 200 words
    expect(t.end(at(210))).toEqual({
      book: 'b1', startedAt: iso(60), endedAt: iso(210), durationSeconds: 150, wordsRead: 300, startPercent: 0.1, endPercent: 0.104,
    })
  })

  it('nothing before the first activity: an open and a restore are no reading', () => {
    const t = opened()
    expect(t.end(at(600))).toBeNull()
  })

  it('time before a jump funds no long move after it', () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.jump(at(240)) // 3 min of reading behind it
    t.relocate(rel(0.3, true), at(241)) // the landing
    t.relocate(rel(0.6, true), at(256)) // a followed link: 15 s at 800 wpm = 200 words
    expect(t.end(at(256))?.wordsRead).toBe(300)
  })

  it('a session under 10 s is not kept', () => {
    const t = opened()
    t.relocate(rel(0.101, true), at(1))
    expect(t.end(at(9))).toBeNull()
  })

  it('time stops 3 min after the last activity, and 5 min without any ends the session', () => {
    const t = opened()
    t.activity(at(0))
    expect(t.tick(at(299))).toBeNull()
    const ended = t.tick(at(300))
    expect(ended).toMatchObject({ durationSeconds: 180, endedAt: iso(300) })
    // Ended: the next activity is a new session.
    t.activity(at(400))
    expect(t.end(at(430))).toMatchObject({ startedAt: iso(400), durationSeconds: 30 })
  })

  it('a gap over 3 min between activities counts 3 min', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(250))
    expect(t.end(at(260))?.durationSeconds).toBe(190)
  })

  it('a clock set back never subtracts, nor ends before it started', () => {
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

  it('at most 4 h', () => {
    const t = opened()
    for (let s = 0; s <= 5 * 3600; s += 60) t.activity(at(s))
    expect(t.end(at(5 * 3600))?.durationSeconds).toBe(14_400)
  })

  it('moves not by the reader (a sync move, a re-layout) count no words; the next turn counts from there', () => {
    const t = opened()
    t.activity(at(0))
    t.activity(at(30)) // 30 s counted: a step could take 400 words
    t.relocate(rel(0.5, false), at(30)) // a sync move
    t.relocate(rel(0.501, true), at(60)) // 100 words
    expect(t.end(at(60))).toMatchObject({ wordsRead: 100, startPercent: 0.1, endPercent: 0.501 })
  })

  it('back then forward again counts the ground once, then what lies past it', () => {
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

  it("a move the page calls the reader's (a link, a long scroll) counts no more than 800 wpm of the time since the last counted step", () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.relocate(rel(0.6, true), at(75)) // 15 s at 800 wpm = 200 words
    expect(t.end(at(80))?.wordsRead).toBe(300)
  })

  it('that time is the counted time: 2 h idle in between gives 3 min, and a new session none', () => {
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

  it("the host's own navigation (Go there, a contents entry) only moves the baseline, its landing relocates too", () => {
    const t = opened()
    t.activity(at(0))
    t.relocate(rel(0.101, true), at(60)) // 100 words
    t.jump(at(60 + 7200)) // 2 h later: "Go there", 20 % on
    t.relocate(rel(0.301, true), at(60 + 7201))
    t.relocate(rel(0.3012, true), at(60 + 7201.5)) // the same landing, relocated again
    t.relocate(rel(0.3022, true), at(60 + 7260)) // the next turn: 100 words
    expect(t.end(at(60 + 7260))).toMatchObject({ wordsRead: 200, endPercent: 0.3022 })
  })

  it('no words where the page has none (CBZ, PDF): time only', () => {
    const t = opened()
    t.relocate(rel(0.2, true, null), at(30))
    t.relocate(rel(0.3, true, null), at(60))
    expect(t.end(at(60))).toMatchObject({ durationSeconds: 30, wordsRead: 0, endPercent: 0.3 })
  })

  it('a book not recorded (bound to null) starts no session', () => {
    const t = opened(null)
    t.relocate(rel(0.2, true), at(30))
    expect(t.end(at(60))).toBeNull()
  })

  it('another open ends the session of the book before; nothing of it counts to the next', () => {
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

  it("the book before's place is not the next one's baseline: its first move counts no words", () => {
    const t = opened('b1')
    t.relocate(rel(0.101, true), at(30))
    t.open(at(60))
    t.bind('b2', at(61))
    t.activity(at(61))
    t.relocate(rel(0.75, true), at(121))
    expect(t.end(at(150))).toMatchObject({ book: 'b2', wordsRead: 0, startPercent: 0.75 })
  })

  it('a bind to another book ends the session of the one before', () => {
    const t = opened('b1')
    t.relocate(rel(0.101, true), at(30))
    expect(t.bind('b2', at(60))).toMatchObject({ book: 'b1', durationSeconds: 30 })
    expect(t.bind('b2', at(61))).toBeNull()
  })
})
