import { describe, it, expect, beforeEach, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ApiError, initApi, type PendingSession } from '@textstack/shared'
import { fakeApi } from '../../../../packages/shared/src/api/__tests__/fakeV2Api'
import {
  clearPendingSessions,
  enqueuePendingSession,
  flushPendingSessions,
} from './pendingSessions'

// Whether a session goes to V2 is decided at send time (`v2On`); the rest run with V2 off.
const v2On = vi.hoisted(() => ({ value: false }))
vi.mock('./v2', () => ({ onV2: async () => v2On.value }))

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
  v2On.value = false
})

describe('an upload session with its V2 id', () => {
  const sent = () => {
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
    return fakeApi({ 'PUT /me/v2/reading/sessions/s-1': [{ status: 200, body: {} }], 'POST /me/reading/sessions': [{ status: 200, body: {} }] }, 'http://api')
  }
  const v2Session = { ...session('x'), editionId: undefined, userBookId: 'b1', clientSessionId: 's-1' }

  it('goes to the V2 route when V2 answers on at send time', async () => {
    const calls = sent()
    v2On.value = true
    await enqueuePendingSession(v2Session)
    await flushPendingSessions()
    expect(calls[0]).toMatchObject({ method: 'PUT', path: '/me/v2/reading/sessions/s-1', body: { bookId: 'b1' } })
    vi.unstubAllGlobals()
  })

  it('goes to the legacy route without the V2 id when V2 is off', async () => {
    const calls = sent()
    await enqueuePendingSession(v2Session)
    await flushPendingSessions()
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/me/reading/sessions' })
    expect(calls[0].body).not.toHaveProperty('clientSessionId')
    vi.unstubAllGlobals()
  })
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
