import { describe, it, expect, vi } from 'vitest'
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  USER_KEY,
  createWriteQueue,
  writeUserIfCurrent,
  type SessionStore,
} from './sessionWrites'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStore extends SessionStore {
  readonly map: Map<string, string>
  /** Every op in order — the queue's whole job is that these do not interleave. */
  readonly log: string[]
  failReadsWith?: Error
}

function createFakeStore(initial: Record<string, string> = {}): FakeStore {
  const map = new Map(Object.entries(initial))
  const log: string[] = []
  const store: FakeStore = {
    map,
    log,
    async getItemAsync(key) {
      if (store.failReadsWith) throw store.failReadsWith
      // A real keychain read is async; yielding here is what lets a competing
      // block slip in if the queue is not doing its job.
      await Promise.resolve()
      log.push(`get:${key}`)
      return map.get(key) ?? null
    },
    async setItemAsync(key, value) {
      await Promise.resolve()
      log.push(`set:${key}`)
      map.set(key, value)
    },
    async deleteItemAsync(key) {
      await Promise.resolve()
      log.push(`del:${key}`)
      map.delete(key)
    },
  }
  return store
}

/**
 * The three writers from `AuthContext`, wired to the real queue and the real
 * guarded write. Nothing here re-implements a decision — the point is to drive
 * production code through the exact orderings the app produces.
 */
function makeSession(signedIn = true) {
  const queue = createWriteQueue()
  const store = createFakeStore(
    signedIn ? { [ACCESS_TOKEN_KEY]: 'a0', [REFRESH_TOKEN_KEY]: 'r0', [USER_KEY]: '{"id":"u1"}' } : {},
  )
  const state = { user: signedIn ? '{"id":"u1"}' : null as string | null }

  const signInWithTokens = (access: string, refresh: string, json: string) => {
    queue.bumpEpoch()
    return queue.run(async () => {
      await store.setItemAsync(ACCESS_TOKEN_KEY, access)
      await store.setItemAsync(REFRESH_TOKEN_KEY, refresh)
      await store.setItemAsync(USER_KEY, json)
      state.user = json
    })
  }

  const signOut = () => {
    queue.bumpEpoch()
    return queue.run(async () => {
      await store.deleteItemAsync(ACCESS_TOKEN_KEY)
      await store.deleteItemAsync(REFRESH_TOKEN_KEY)
      await store.deleteItemAsync(USER_KEY)
      state.user = null
    })
  }

  const updateUser = (json: string) =>
    writeUserIfCurrent({
      queue,
      store,
      json,
      onApplied: () => { state.user = json },
    })

  return { queue, store, state, signInWithTokens, signOut, updateUser }
}

// ---------------------------------------------------------------------------
// The queue itself
// ---------------------------------------------------------------------------

describe('createWriteQueue', () => {
  it('runs blocks one at a time, in enqueue order', async () => {
    const queue = createWriteQueue()
    const order: string[] = []
    const block = (name: string, ticks: number) => async () => {
      order.push(`${name}:start`)
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      order.push(`${name}:end`)
    }
    // `a` yields more than `b`, so without serialisation `b` would finish first.
    await Promise.all([queue.run(block('a', 5)), queue.run(block('b', 0))])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('does not interleave the three writes of a sign-in', async () => {
    // The corruption this prevents: a guest access token next to an account
    // refresh token. Nothing checks for that pairing; it shows up a launch
    // later as a 401 loop.
    const { store, signInWithTokens } = makeSession(false)
    await Promise.all([
      signInWithTokens('guest-a', 'guest-r', '{"id":"g"}'),
      signInWithTokens('acct-a', 'acct-r', '{"id":"u"}'),
    ])
    expect(store.log).toEqual([
      `set:${ACCESS_TOKEN_KEY}`, `set:${REFRESH_TOKEN_KEY}`, `set:${USER_KEY}`,
      `set:${ACCESS_TOKEN_KEY}`, `set:${REFRESH_TOKEN_KEY}`, `set:${USER_KEY}`,
    ])
    // Whoever won, the pair is internally consistent.
    const access = store.map.get(ACCESS_TOKEN_KEY)!
    const refresh = store.map.get(REFRESH_TOKEN_KEY)!
    expect(access.split('-')[0]).toBe(refresh.split('-')[0])
  })

  it('passes the block’s value back to its own caller', async () => {
    const queue = createWriteQueue()
    await expect(queue.run(async () => 42)).resolves.toBe(42)
  })

  it('rejects the caller when the block rejects', async () => {
    const queue = createWriteQueue()
    await expect(queue.run(async () => { throw new Error('nope') })).rejects.toThrow('nope')
  })

  it('is not wedged by a rejected predecessor', async () => {
    // The classic version of this bug: chaining with `.then(fn)` only, so one
    // failed write poisons every later write for the life of the process.
    const queue = createWriteQueue()
    await queue.run(async () => { throw new Error('boom') }).catch(() => {})
    await expect(queue.run(async () => 'still works')).resolves.toBe('still works')
  })

  it('still runs later blocks after an unhandled earlier rejection', async () => {
    const queue = createWriteQueue()
    // Deliberately not awaited or caught before the next enqueue.
    const failing = queue.run(async () => { throw new Error('boom') })
    const after = queue.run(async () => 'ran')
    await expect(after).resolves.toBe('ran')
    await expect(failing).rejects.toThrow('boom')
  })

  it('starts at epoch 0 and increments synchronously', () => {
    const queue = createWriteQueue()
    expect(queue.epoch).toBe(0)
    queue.bumpEpoch()
    queue.bumpEpoch()
    expect(queue.epoch).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// F1 — updateUser must never resurrect a session that ended
// ---------------------------------------------------------------------------

describe('writeUserIfCurrent', () => {
  it('writes the user and applies it when the session is intact', async () => {
    const { store, state, updateUser } = makeSession()
    await expect(updateUser('{"id":"u1","name":"Renamed"}')).resolves.toBe('written')
    expect(store.map.get(USER_KEY)).toBe('{"id":"u1","name":"Renamed"}')
    expect(state.user).toBe('{"id":"u1","name":"Renamed"}')
  })

  // THE bug. `signOut()` bumps the epoch and enqueues its three deletes; the
  // profile-refresh effect's `getProfile()` resolves a moment later — its
  // `cancelled` flag only flips on a React commit, which lags — and calls
  // `updateUser`, which enqueues AFTER the deletes and rewrites the `user` key.
  //
  // Note what the epoch cannot do here: `updateUser` starts after the bump, so
  // it captures the already-bumped value and compares equal. The guard that
  // catches this is the invariant itself — never write `user` when there is no
  // access token.
  it('discards the write when sign-out already cleared the session', async () => {
    const { store, state, signOut, updateUser } = makeSession()
    const out = signOut()
    const write = updateUser('{"id":"u1","name":"From a stale profile fetch"}')
    await Promise.all([out, write])

    await expect(write).resolves.toBe('discarded:session-gone')
    // The corrupt state this prevents: `user` present, tokens gone. `decideMint`
    // reads that as `session-exists` forever, so `ensureSession` never mints
    // again and every request 401-loops.
    expect(store.map.has(USER_KEY)).toBe(false)
    expect(store.map.has(ACCESS_TOKEN_KEY)).toBe(false)
    expect(state.user).toBeNull()
  })

  it('discards when the tokens were cleared by a terminal auth failure', async () => {
    // `api.ts` deletes the tokens itself before emitting, then the listener
    // bumps the epoch and enqueues its `user` delete. Same shape, no signOut().
    const { store, state, queue, updateUser } = makeSession()
    store.map.delete(ACCESS_TOKEN_KEY)
    store.map.delete(REFRESH_TOKEN_KEY)
    queue.bumpEpoch()
    await expect(updateUser('{"id":"u1"}')).resolves.toBe('discarded:session-gone')
    expect(store.map.has(USER_KEY)).toBe(true) // untouched; the listener deletes it
    expect(state.user).toBe('{"id":"u1"}')     // …and sets state to null itself
  })

  it('discards when the epoch moves after it enqueued but before it ran', async () => {
    // The other direction: `updateUser` gets in line first, then a sign-in
    // starts. Its DTO is now from the previous generation.
    const { state, store, signInWithTokens, updateUser } = makeSession()
    const write = updateUser('{"id":"u1","name":"Old session"}')
    const signIn = signInWithTokens('acct-a', 'acct-r', '{"id":"u2"}')
    await Promise.all([write, signIn])
    await expect(write).resolves.toBe('discarded:epoch-moved')
    expect(store.map.get(USER_KEY)).toBe('{"id":"u2"}')
    expect(state.user).toBe('{"id":"u2"}')
  })

  it('never leaves a user without an access token, whichever way the race runs', async () => {
    // Both orderings, asserted as one invariant rather than two orderings.
    for (const signOutFirst of [true, false]) {
      const { store, signOut, updateUser } = makeSession()
      const ops = signOutFirst
        ? [signOut(), updateUser('{"id":"u1"}')]
        : [updateUser('{"id":"u1"}'), signOut()]
      await Promise.all(ops)
      expect(store.map.has(USER_KEY) && !store.map.has(ACCESS_TOKEN_KEY)).toBe(false)
    }
  })

  it('writes anyway when the keychain read throws — unreadable is not absent', async () => {
    // A locked device must not silently swallow every profile update.
    const { store, state, updateUser } = makeSession()
    store.failReadsWith = new Error('SecureStore unavailable')
    await expect(updateUser('{"id":"u1","name":"Renamed"}')).resolves.toBe('written')
    expect(state.user).toBe('{"id":"u1","name":"Renamed"}')
  })

  it('runs inside the queue, so it cannot split a sign-in’s three writes', async () => {
    const { store, signInWithTokens, updateUser } = makeSession(false)
    const signIn = signInWithTokens('acct-a', 'acct-r', '{"id":"u2"}')
    const write = updateUser('{"id":"u2","name":"Renamed"}')
    await Promise.all([signIn, write])
    const setIndexes = store.log
      .map((entry, i) => ({ entry, i }))
      .filter((e) => e.entry.startsWith('set:'))
      .map((e) => e.i)
    // The sign-in's three sets are consecutive; nothing landed between them.
    expect(setIndexes.slice(0, 3)).toEqual([setIndexes[0], setIndexes[0] + 1, setIndexes[0] + 2])
  })

  it('does not touch the store at all when it discards', async () => {
    const { store, signOut, updateUser } = makeSession()
    await signOut()
    store.log.length = 0
    await updateUser('{"id":"u1"}')
    expect(store.log.filter((l) => l.startsWith('set:'))).toEqual([])
  })

  it('does not call onApplied when it discards', async () => {
    const { queue, store, signOut } = makeSession()
    await signOut()
    const onApplied = vi.fn()
    await writeUserIfCurrent({ queue, store, json: '{"id":"u1"}', onApplied })
    expect(onApplied).not.toHaveBeenCalled()
  })
})
