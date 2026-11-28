import { describe, it, expect, vi } from 'vitest'
import { createSingleFlight } from './singleFlight'

/** A promise plus its resolvers, so a test can hold a call open. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createSingleFlight', () => {
  it('N concurrent callers produce exactly one invocation', async () => {
    const flight = createSingleFlight<string>()
    const gate = deferred<string>()
    const task = vi.fn(() => gate.promise)

    const callers = [flight.run(task), flight.run(task), flight.run(task), flight.run(task)]
    gate.resolve('guest-1')

    expect(task).toHaveBeenCalledTimes(1)
    expect(await Promise.all(callers)).toEqual(['guest-1', 'guest-1', 'guest-1', 'guest-1'])
  })

  it('hands every joiner the same promise, not a copy', () => {
    const flight = createSingleFlight<string>()
    const gate = deferred<string>()
    const a = flight.run(() => gate.promise)
    const b = flight.run(() => gate.promise)
    expect(a).toBe(b)
    gate.resolve('x')
  })

  it('releases the slot on resolve, so a later caller starts a fresh call', async () => {
    const flight = createSingleFlight<number>()
    let n = 0
    const task = vi.fn(async () => ++n)

    expect(await flight.run(task)).toBe(1)
    expect(flight.isInFlight).toBe(false)
    expect(await flight.run(task)).toBe(2)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('releases the slot on REJECT — a leaked slot would wedge minting for the rest of the process', async () => {
    // The bug this guards: release only in the success path and one failed
    // mint (offline, or a 429 from the guest rate limit) keeps the slot
    // forever. Every later ensureSession() would then be handed that same
    // stale rejection and the reader would never get a session again until
    // the app is killed — a transient failure turned permanent.
    const flight = createSingleFlight<string>()
    const failing = vi.fn(async () => { throw new Error('offline') })

    await expect(flight.run(failing)).rejects.toThrow('offline')
    expect(flight.isInFlight).toBe(false)

    const succeeding = vi.fn(async () => 'guest-2')
    expect(await flight.run(succeeding)).toBe('guest-2')
    expect(succeeding).toHaveBeenCalledTimes(1)
  })

  it('shares the rejection with all joiners, then recovers', async () => {
    const flight = createSingleFlight<string>()
    const gate = deferred<string>()
    const task = vi.fn(() => gate.promise)

    const a = flight.run(task)
    const b = flight.run(task)
    gate.reject(new Error('429'))

    await expect(a).rejects.toThrow('429')
    await expect(b).rejects.toThrow('429')
    expect(task).toHaveBeenCalledTimes(1)
    expect(flight.isInFlight).toBe(false)
  })

  it('a task that throws synchronously never occupies the slot', async () => {
    const flight = createSingleFlight<string>()
    const boom = () => { throw new Error('sync boom') }

    await expect(flight.run(boom as unknown as () => Promise<string>)).rejects.toThrow('sync boom')
    expect(flight.isInFlight).toBe(false)
    expect(await flight.run(async () => 'ok')).toBe('ok')
  })

  it('reports isInFlight while a call is open', async () => {
    const flight = createSingleFlight<string>()
    const gate = deferred<string>()
    const call = flight.run(() => gate.promise)
    expect(flight.isInFlight).toBe(true)
    gate.resolve('done')
    await call
    expect(flight.isInFlight).toBe(false)
  })
})
