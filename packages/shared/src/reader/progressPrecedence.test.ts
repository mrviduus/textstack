import { describe, it, expect } from 'vitest'
import { localProgressWins, MAX_CLIENT_SKEW_MS } from './progressPrecedence'

const T = Date.parse('2026-05-01T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('localProgressWins', () => {
  it('no local record → server', () => {
    expect(localProgressWins(null, { clientUpdatedAt: null })).toBe(false)
  })

  it('no server row → local', () => {
    expect(localProgressWins({ updatedAt: T, synced: true }, null)).toBe(true)
  })

  it('local stamp newer than the server CLIENT stamp → local', () => {
    expect(localProgressWins({ updatedAt: T + 1, synced: true }, { clientUpdatedAt: iso(T) })).toBe(true)
  })

  it('an unsynced local write still loses to a newer write from another device', () => {
    expect(localProgressWins({ updatedAt: T }, { clientUpdatedAt: iso(T + 60_000) })).toBe(false)
  })

  it('equal stamps are the same write → server', () => {
    expect(localProgressWins({ updatedAt: T }, { clientUpdatedAt: iso(T) })).toBe(false)
  })

  it('never reads the server-clock updatedAt', () => {
    // The row was written an hour "later" by the server's clock; the client stamp is older than
    // the local record, so local wins. The old comparison (local vs updatedAt) said server.
    const server = { updatedAt: iso(T + 3_600_000), clientUpdatedAt: iso(T - 5_000) }
    expect(localProgressWins({ updatedAt: T, synced: true }, server)).toBe(true)
  })

  it('no client stamp on the row: unsynced local wins, synced defers to server', () => {
    expect(localProgressWins({ updatedAt: T }, { clientUpdatedAt: null })).toBe(true)
    expect(localProgressWins({ updatedAt: T, synced: true }, { clientUpdatedAt: null })).toBe(false)
    expect(localProgressWins({ updatedAt: T, synced: true }, {})).toBe(false)
  })

  it('an unparseable client stamp is treated as absent', () => {
    expect(localProgressWins({ updatedAt: T, synced: true }, { clientUpdatedAt: 'garbage' })).toBe(false)
    expect(localProgressWins({ updatedAt: T }, { clientUpdatedAt: 'garbage' })).toBe(true)
  })

  it('a fast device\'s acknowledged write, stored clamped, is the same write → server', () => {
    // Device 1h fast; the server (now T) stored its stamp clamped to T + 5 min.
    const server = { updatedAt: iso(T), clientUpdatedAt: iso(T + MAX_CLIENT_SKEW_MS) }
    expect(localProgressWins({ updatedAt: T + 3_600_000, synced: true }, server)).toBe(false)
  })

  it('an unsynced local stamp is not clamped against the row', () => {
    // An honest write made after a clamped row must still win: the server will take it on arrival.
    const server = { updatedAt: iso(T), clientUpdatedAt: iso(T + MAX_CLIENT_SKEW_MS) }
    expect(localProgressWins({ updatedAt: T + 3_600_000 }, server)).toBe(true)
  })
})
