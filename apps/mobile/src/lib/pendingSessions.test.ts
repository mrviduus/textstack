import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ApiError, type PendingSession } from '@textstack/shared'
import {
  clearPendingSessions,
  enqueuePendingSession,
  flushPendingSessions,
} from './pendingSessions'

const KEY = 'reading.pendingSessions'

function session(editionId: string): PendingSession {
  const start = Date.now() - 120_000
  return {
    editionId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 60_000).toISOString(),
    durationSeconds: 60,
    wordsRead: 5,
    startPercent: 0.1,
    endPercent: 0.2,
  }
}

async function queued(): Promise<PendingSession[]> {
  return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]')
}

const offline = async () => { throw new ApiError(0, 'offline') }

beforeEach(async () => {
  await AsyncStorage.removeItem(KEY)
})

describe('pendingSessions (mobile storage)', () => {
  it('flushPendingSessions_SubmitFailsOffline_SessionSurvivesForNextFlush', async () => {
    await enqueuePendingSession(session('a'))
    await flushPendingSessions(offline)
    expect((await queued()).map(s => s.editionId)).toEqual(['a'])

    const sent: string[] = []
    await flushPendingSessions(async (s) => { sent.push(s.editionId!) })
    expect(sent).toEqual(['a'])
    expect(await queued()).toEqual([])
  })

  it('flushPendingSessions_EnqueueDuringFlush_IsNotOverwritten', async () => {
    await enqueuePendingSession(session('a'))
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const flushing = flushPendingSessions(async () => { await gate })
    const enqueuing = enqueuePendingSession(session('b'))
    release()
    await Promise.all([flushing, enqueuing])
    expect((await queued()).map(s => s.editionId)).toEqual(['b'])
  })

  it('flushPendingSessions_PermanentRejection_Dropped', async () => {
    await enqueuePendingSession(session('gone'))
    await flushPendingSessions(async () => { throw new ApiError(404, 'gone') })
    expect(await queued()).toEqual([])
  })

  it('clearPendingSessions_RemovesQueue', async () => {
    await enqueuePendingSession(session('a'))
    await clearPendingSessions()
    expect(await queued()).toEqual([])
  })

  it('flushPendingSessions_CorruptStorage_SubmitsNothingAndDoesNotThrow', async () => {
    await AsyncStorage.setItem(KEY, '{not json')
    const sent: PendingSession[] = []
    await flushPendingSessions(async (s) => { sent.push(s) })
    expect(sent).toEqual([])
  })
})
