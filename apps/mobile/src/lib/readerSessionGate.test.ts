import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  readerGateState, READER_SESSION_GATE_TIMEOUT_MS, READER_SESSION_GATE_RETRY_MS,
  gateSkipsWait, gateGaveUp, gateMemory, type ReaderGateState,
} from './readerSessionGate'
import type { EnsureSessionResult } from './guestSession'

describe('readerGateState — hold the blank, or mount the reader', () => {
  const cases: Array<{
    name: string
    input: { authLoading: boolean; outcome: EnsureSessionResult | null; timedOut: boolean }
    expected: ReaderGateState
  }> = [
    {
      name: 'bootstrap still reading the keychain → wait',
      input: { authLoading: true, outcome: null, timedOut: false },
      expected: 'wait',
    },
    {
      name: 'bootstrap settled, mint in flight → wait',
      input: { authLoading: false, outcome: null, timedOut: false },
      expected: 'wait',
    },
    {
      // THE case. A guest mint that fails must cost the reader nothing but a
      // session: reading works offline from the chapter cache, and a gate
      // that hid the book on a failed network call would break the one thing
      // the reader is for.
      name: 'MINT FAILED (offline / 429 / token-less response) → render, signed out',
      input: { authLoading: false, outcome: { status: 'failed', error: new Error('offline') }, timedOut: false },
      expected: 'render',
    },
    {
      // Same guarantee, other trigger: a socket that hangs open with no
      // answer. The deadline is measured from gate mount, not from the
      // request, so nothing about the network can extend it.
      name: 'TIMED OUT with no answer at all → render, signed out',
      input: { authLoading: false, outcome: null, timedOut: true },
      expected: 'render',
    },
    {
      name: 'timed out while bootstrap is STILL loading → render anyway (the deadline outranks everything)',
      input: { authLoading: true, outcome: null, timedOut: true },
      expected: 'render',
    },
    {
      name: 'minted → render',
      input: { authLoading: false, outcome: { status: 'minted' }, timedOut: false },
      expected: 'render',
    },
    {
      name: 'account already restored → render, no mint happened',
      input: { authLoading: false, outcome: { status: 'existing', isGuest: false }, timedOut: false },
      expected: 'render',
    },
    {
      name: 'guest already present → render',
      input: { authLoading: false, outcome: { status: 'existing', isGuest: true }, timedOut: false },
      expected: 'render',
    },
    {
      name: 'mint discarded because a sign-in won the race → render',
      input: { authLoading: false, outcome: { status: 'discarded', reason: 'epoch-moved' }, timedOut: false },
      expected: 'render',
    },
    {
      // Bootstrap never answered inside its own timeout, so ensureSession
      // refused to mint. That is a settled answer — "we still do not know" —
      // and the book opens on it rather than waiting further.
      name: 'mint skipped because bootstrap never settled → render',
      input: { authLoading: false, outcome: { status: 'skipped', reason: 'bootstrapping' }, timedOut: false },
      expected: 'render',
    },
  ]

  for (const c of cases) {
    it(c.name, () => { expect(readerGateState(c.input)).toBe(c.expected) })
  }

  it('every terminal outcome renders — no status may ever hide the book', () => {
    const terminal: EnsureSessionResult[] = [
      { status: 'existing', isGuest: false },
      { status: 'existing', isGuest: true },
      { status: 'minted' },
      { status: 'discarded', reason: 'epoch-moved' },
      { status: 'discarded', reason: 'account-arrived' },
      { status: 'skipped', reason: 'bootstrapping' },
      { status: 'failed', error: new Error('boom') },
    ]
    for (const outcome of terminal) {
      expect(readerGateState({ authLoading: false, outcome, timedOut: false })).toBe('render')
    }
  })

  it('the blank is capped at a few seconds, not web bootstrap length', () => {
    // A blank screen past ~4s reads as a crash and the user backs out of the
    // book; web's 15s bootstrap budget would be unusable here.
    expect(READER_SESSION_GATE_TIMEOUT_MS).toBeGreaterThan(1_000)
    expect(READER_SESSION_GATE_TIMEOUT_MS).toBeLessThanOrEqual(4_000)
  })
})

describe('M4 — a gate that gave up lets the next chapter open at once', () => {
  it('skips the wait inside the retry window, and only then', () => {
    expect(gateSkipsWait(null, 1_000)).toBe(false)
    expect(gateSkipsWait(1_000, 1_000 + 2_000)).toBe(true)
    expect(gateSkipsWait(1_000, 1_000 + READER_SESSION_GATE_RETRY_MS)).toBe(false)
    // A clock that went backwards is no evidence about the network.
    expect(gateSkipsWait(10_000, 1_000)).toBe(false)
  })

  it('gave up = failed, skipped, or timed out with no answer; a session is not giving up', () => {
    expect(gateGaveUp({ outcome: { status: 'failed', error: null }, timedOut: false })).toBe(true)
    expect(gateGaveUp({ outcome: { status: 'skipped', reason: 'bootstrapping' }, timedOut: false })).toBe(true)
    expect(gateGaveUp({ outcome: null, timedOut: true })).toBe(true)
    expect(gateGaveUp({ outcome: { status: 'minted' }, timedOut: true })).toBe(false)
    expect(gateGaveUp({ outcome: { status: 'existing', isGuest: false }, timedOut: false })).toBe(false)
  })

  it('a give-up is remembered, a success forgets it', () => {
    gateMemory.record(true, 5_000)
    expect(gateMemory.skipsWait(6_000)).toBe(true)
    gateMemory.record(false, 7_000)
    expect(gateMemory.skipsWait(8_000)).toBe(false)
  })
})

describe('M4 wiring — SessionGate consults and feeds the memory', () => {
  const gate = readFileSync(resolve(__dirname, '../components/SessionGate.tsx'), 'utf8')
  it('a skipped gate renders at once and never mints', () => {
    expect(gate).toMatch(/useState\(\(\) => gateMemory\.skipsWait\(\)\)/)
    expect(gate).toMatch(/useState\(skipped\)/)
    expect(gate).toMatch(/startedRef = useRef\(skipped\)/)
  })
  it('the deadline and the mint answer are both recorded', () => {
    expect(gate).toContain('gateMemory.record(true)')
    expect(gate).toContain('gateMemory.record(gateGaveUp(')
  })
})
