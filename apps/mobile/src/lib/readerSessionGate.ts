import type { EnsureSessionResult } from './guestSession'

/**
 * Should the reader mount yet?
 *
 * **Why a render gate and not merely an early `ensureSession()` call.**
 * `isAuthenticated` is a *fetch* input, not a display flag, all through the
 * reader: `useReaderBook.ts` has it in the dependency array of the effect that
 * loads the book, so flipping it mid-mount refetches the book and re-derives
 * the chapter list; `useEditionReaderSource.ts` re-creates `persist` and
 * `loadPosition` on it (and `loadPosition` is what the scroll-restore gate
 * awaits); `useReaderVocabMap.ts` rebuilds its map. A session that arrives 400ms
 * after mount therefore reruns the whole load underneath a reader that has
 * already restored the reader's scroll position. Holding a themed blank until
 * the session question is *settled* makes `isAuthenticated` constant for the
 * reader's entire lifetime, which is the only version of this that is actually
 * race-free.
 *
 * **And why the gate can never hide the book.** Reading works offline from the
 * chapter cache and must keep working; a session is an enhancement, not a
 * precondition. Every failure mode — mint rejected, rate limited, offline,
 * bootstrap wedged, deadline blown — resolves to `'render'`. The reader opens
 * signed out and degraded rather than not at all.
 */
export type ReaderGateState = 'wait' | 'render'

/**
 * How long the blank may be held before the reader opens regardless.
 *
 * 3s, and the number is picked against how the failures actually behave rather
 * than against a percentile of the happy path:
 *
 * - Offline does not use this budget at all. `fetch` rejects on DNS/connect in
 *   well under a second, `ensureSession()` answers `failed`, and the gate opens
 *   immediately. The deadline exists for the nastier case — a captive portal or
 *   a dead-but-connected network where the socket hangs open with no answer.
 * - The happy path is one unauthenticated `POST /auth/guest` after a local
 *   keychain read. On a slow-but-working mobile connection that lands inside
 *   ~1.5s; 3s leaves headroom for a TLS handshake on a cold radio.
 * - Past roughly 4s a blank screen stops reading as "loading" and starts
 *   reading as "the app is broken", and the user backs out of the book. That
 *   upper bound is what makes 3s the ceiling rather than, say, web's 15s
 *   bootstrap timeout — which would be an eternity in front of a book.
 */
export const READER_SESSION_GATE_TIMEOUT_MS = 3_000

export function readerGateState(input: {
  /** `AuthContext.isLoading` — the SecureStore bootstrap read has not answered. */
  authLoading: boolean
  /** Result of `ensureSession()`, or `null` while the call is still in flight. */
  outcome: EnsureSessionResult | null
  /** `READER_SESSION_GATE_TIMEOUT_MS` has elapsed since the gate mounted. */
  timedOut: boolean
}): ReaderGateState {
  // First and unconditional: the deadline outranks every other input. This is
  // the clause that guarantees a hung network can never cost the reader the
  // book they already have cached on the device.
  if (input.timedOut) return 'render'
  if (input.authLoading) return 'wait'
  // `outcome` is non-null for EVERY terminal state, including `failed` and
  // `skipped`. "The mint failed" is a settled answer to the session question,
  // not an unsettled one — so it renders.
  if (input.outcome === null) return 'wait'
  return 'render'
}

/**
 * How long a gate that opened WITHOUT a session (mint failed, or the deadline
 * passed) lets the next gate skip the wait (M4).
 *
 * Every chapter change remounts the reader route and with it this gate, so on a
 * dead-but-connected network a signed-out reader stared at a blank for the full
 * 3s on every chapter. One failed attempt is the answer for a while: the next
 * gates render at once and do not mint (a mint landing mid-read is the race the
 * gate exists to prevent). A success clears it.
 */
export const READER_SESSION_GATE_RETRY_MS = 5 * 60_000

/** Should a gate mounting at `now` skip the wait, given when one last gave up? */
export function gateSkipsWait(gaveUpAt: number | null, now: number): boolean {
  return gaveUpAt != null && now - gaveUpAt >= 0 && now - gaveUpAt < READER_SESSION_GATE_RETRY_MS
}

/** Did this gate open without a session? A settled `existing`/`minted`/`discarded` is a session. */
export function gateGaveUp(input: { outcome: EnsureSessionResult | null; timedOut: boolean }): boolean {
  if (input.outcome) return input.outcome.status === 'failed' || input.outcome.status === 'skipped'
  return input.timedOut
}

// One slot, module state: one app process, one answer about the network.
let lastGaveUpAt: number | null = null
export const gateMemory = {
  skipsWait: (now = Date.now()) => gateSkipsWait(lastGaveUpAt, now),
  record: (gaveUp: boolean, now = Date.now()) => { lastGaveUpAt = gaveUp ? now : null },
  /** The 3s deadline fired. It gave up only if no answer had arrived — the gate stays mounted
   *  around the reader, so the timer still fires after a fast success, and must not undo it. */
  deadlinePassed: (outcome: EnsureSessionResult | null, now = Date.now()) => {
    if (outcome === null) lastGaveUpAt = now
  },
}
