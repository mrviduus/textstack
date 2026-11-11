import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPENED_CAP_MS, OPENED_FLOOR_MS, OPENED_MS_PER_MB, READY_DEADLINE_MS, createDeadlines, openedDeadlineMs,
} from './deadlines.mjs'

const MB = 1_048_576

describe('v2 host deadlines (#1227)', () => {
  let changes: (string | null)[]
  const make = () => createDeadlines((o) => { changes.push(o) })
  beforeEach(() => {
    vi.useFakeTimers()
    changes = []
  })
  afterEach(() => vi.useRealTimers())

  it('openedDeadlineMs_FloorPlusPerMb_Capped', () => {
    expect(openedDeadlineMs(0)).toBe(OPENED_FLOOR_MS)
    expect(openedDeadlineMs(undefined)).toBe(OPENED_FLOOR_MS)
    expect(openedDeadlineMs(Number.NaN)).toBe(OPENED_FLOOR_MS)
    expect(openedDeadlineMs(-5)).toBe(OPENED_FLOOR_MS)
    expect(openedDeadlineMs(10 * MB)).toBe(OPENED_FLOOR_MS + 10 * OPENED_MS_PER_MB)
    // The R4 gate's 87 MB book: ~107 s, against the 7 s measured on the emulator.
    expect(openedDeadlineMs(87 * MB)).toBe(OPENED_FLOOR_MS + 87 * OPENED_MS_PER_MB)
    expect(openedDeadlineMs(10_000 * MB)).toBe(OPENED_CAP_MS)
  })

  it('noReadyByTheDeadline_OverdueReady_ALateReadyClearsIt', () => {
    const d = make()
    d.waitReady(READY_DEADLINE_MS)
    vi.advanceTimersByTime(READY_DEADLINE_MS - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(changes).toEqual(['ready'])
    expect(d.overdue()).toBe('ready')
    d.ready()
    expect(changes).toEqual(['ready', null])
  })

  it('readyInTime_NothingFires', () => {
    const d = make()
    d.waitReady(READY_DEADLINE_MS)
    d.ready()
    vi.advanceTimersByTime(READY_DEADLINE_MS * 2)
    expect(changes).toEqual([])
  })

  it('noOpenedByTheSizedDeadline_OverdueOpened_ALateAnswerClearsIt', () => {
    const d = make()
    d.waitOpened(30 * MB)
    vi.advanceTimersByTime(openedDeadlineMs(30 * MB) - 1)
    expect(changes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(d.overdue()).toBe('opened')
    d.answered()
    expect(changes).toEqual(['opened', null])
  })

  it('aNewerOpen_RestartsTheWait_AndClearsAnOverdueOpened', () => {
    const d = make()
    d.waitOpened(0)
    vi.advanceTimersByTime(OPENED_FLOOR_MS - 1000)
    d.waitOpened(0)
    vi.advanceTimersByTime(OPENED_FLOOR_MS - 1)
    expect(changes).toEqual([]) // the first open's timer is gone
    vi.advanceTimersByTime(1)
    expect(changes).toEqual(['opened'])
    d.waitOpened(0)
    expect(changes).toEqual(['opened', null])
  })

  it('aReload_EndsTheOpenWait_AndRestartsTheReadyWait', () => {
    const d = make()
    d.waitOpened(0)
    vi.advanceTimersByTime(OPENED_FLOOR_MS)
    d.waitReady(READY_DEADLINE_MS)
    expect(changes).toEqual(['opened', null])
    vi.advanceTimersByTime(OPENED_FLOOR_MS)
    expect(changes).toEqual(['opened', null, 'ready'])
  })

  it('answeredOrReadyOfTheOtherKind_DoesNotClear', () => {
    const d = make()
    d.waitReady(READY_DEADLINE_MS)
    vi.advanceTimersByTime(READY_DEADLINE_MS)
    d.answered()
    expect(d.overdue()).toBe('ready')
  })

  it('dispose_NoLaterChange', () => {
    const d = make()
    d.waitReady(READY_DEADLINE_MS)
    d.waitOpened(0)
    d.dispose()
    vi.advanceTimersByTime(OPENED_CAP_MS)
    expect(changes).toEqual([])
  })
})
