/**
 * Whether the reader may write its position yet.
 *
 * A reader got to 10% of chapter two, pressed Continue, was sent back to chapter one — and the
 * app then overwrote their place with `scroll:1-dramatis-personae:0`, percent 0, without them
 * touching anything. The routing half of that is fixed separately; this is the half that did the
 * damage.
 *
 * The WebView posts a `progress` message on its own `load` event, before any restore has been
 * injected, carrying `scrollY: 0`. Nothing on the mobile reflow path stopped that reaching the
 * server: `saveProgress` checked `enabled`, `bookKey` and `chapterSlug`, none of which say
 * anything about whether the reader is where they chose to be. `restoredRef` existed and no
 * writer read it.
 *
 * Both other readers in this codebase already had this. The PDF viewer has `pdfPersistGate`
 * (`awaitingTarget → jumping → live`), written after the same class of bug. The web reader keeps
 * `restoredFor` as state — deliberately not a ref — so the save-on-open effect can re-run *after*
 * restore, with the comment that the offset must reflect the restored scroll "not a transient 0".
 * The mobile reflow reader was the one that never got it.
 *
 * Note what this is not: a rule against writing a smaller number. Going back is something readers
 * legitimately do, and `pdfPersistGate` argues that case at length. The rule is about *when*, not
 * about which way the number moved.
 */
export interface ReaderWriteGateInput {
  /** False when another viewer owns this book's position (Original-layout PDF). */
  enabled: boolean
  /** Null until the edition/book id resolves. */
  bookKey: string | null | undefined
  /** The chapter being read. */
  chapterSlug: string | null | undefined
  /**
   * The chapter whose restore has completed — including the "nothing saved, stay at the top" case,
   * which is a completed restore and must open the gate, or a book opened for the first time could
   * never be saved at all.
   */
  restoredFor: string | null
  /**
   * The reader is leaving for the chapter the newer-position prompt named. A write now would only
   * re-stamp the chapter being left as the newest position and bury the other device's (C2).
   */
  leaving?: boolean
}

/**
 * A type predicate rather than a plain boolean, so the caller keeps the narrowing the inline
 * `if (!bookKey || !chapterSlug) return` used to give it. Otherwise extracting this check would
 * have cost a second, duplicate one immediately after it — and two copies of a guard is how the
 * two halves drift apart.
 */
export function canPersistPosition(
  input: ReaderWriteGateInput,
): input is ReaderWriteGateInput & { bookKey: string; chapterSlug: string } {
  const { enabled, bookKey, chapterSlug, restoredFor } = input
  if (!enabled || !bookKey || !chapterSlug || input.leaving) return false
  // Per chapter, not a single boolean: moving to the next chapter starts a new restore, and a
  // write in that window would persist the new chapter at offset 0.
  return restoredFor === chapterSlug
}

/**
 * When a restore counts as finished.
 *
 * The first version of this gate answered "has a restore been *issued*", and QA found the gap the
 * same week: open a book at 45%, press back within a second, and the position was 0.66%. Issuing a
 * restore means injecting JavaScript into a WebView. The scroll happens one paint later, in another
 * realm, and until it reports back the newest position RN holds is the `scrollY: 0` the page sent
 * on its own load event. The gate was open across that whole window.
 *
 * So the phase between "asked" and "arrived" has to exist, and only the WebView can end it. This is
 * the same machine as `pdfPersistGate` — written after the same class of bug, on the other reader —
 * with the same three ways out, for the same reasons: an id-matched acknowledgement, a positional
 * heuristic in case the ack is lost, and a timeout so a restore that can never land cannot disable
 * saving for the whole session.
 */
export type RestoreGatePhase =
  /** Entered a chapter; nothing has been asked of the WebView yet. */
  | 'awaiting'
  /** A restore was injected and has not reported back. The destructive window. */
  | 'issued'
  /** The reader is where they chose to be. Writes allowed. */
  | 'open'

export interface RestoreGateState {
  phase: RestoreGatePhase
  /** The chapter this gate belongs to. A write is only ever allowed for this one. */
  chapterSlug: string | null
  /** Identifies the in-flight restore, so a stale ack from the previous chapter cannot open it. */
  restoreId: number
  issuedAt: number
  /**
   * An ack for an OLDER restore arrived while this one is in flight. Its landing report follows it,
   * so position reports no longer stand in for this restore's ack — a typography reflow injected
   * mid-restore scrolls back to the top it captured, and that report would land in an open gate.
   * The id-matched ack or the deadline opens it instead.
   */
  staleAck: boolean
}

export type RestoreGateEvent =
  /** A chapter mounted, or the reader moved to another one. Closes the gate. */
  | { type: 'chapterEntered'; chapterSlug: string | null }
  /** A restore was injected into the WebView. */
  | { type: 'restoreIssued'; restoreId: number; at: number }
  /**
   * There was no saved position. That is a *completed* restore — the top of the chapter is where
   * the reader should be — and it must open the gate, or a book opened for the first time could
   * never be saved at all.
   */
  | { type: 'nothingToRestore' }
  /** The WebView acknowledged the restore it was given. */
  | { type: 'restoreLanded'; restoreId: number }
  /** The WebView reported a scroll position, restore-driven or from the reader's own finger. */
  | { type: 'positionReported'; scrollY: number }
  /** `RESTORE_SETTLE_MS` passed with no acknowledgement. The escape hatch. */
  | { type: 'restoreTimedOut'; restoreId: number }

export const RESTORE_GATE_INITIAL: RestoreGateState = {
  phase: 'awaiting',
  chapterSlug: null,
  restoreId: 0,
  issuedAt: 0,
  staleAck: false,
}

/**
 * How long to wait for a restore to land before allowing writes anyway.
 *
 * The escape hatch matters more than the happy path, exactly as it does for `PDF_JUMP_SETTLE_MS`
 * (same value, same argument): without it, one injection that never arrives — a WebView reloaded
 * out from under us, a message dropped — would silently stop the reader's position being saved for
 * the rest of the session. Losing the tail of a session is bad; losing every session is worse.
 */
export const RESTORE_SETTLE_MS = 4000

export function restoreGateReduce(
  state: RestoreGateState,
  event: RestoreGateEvent,
): RestoreGateState {
  switch (event.type) {
    case 'chapterEntered':
      // Keeps the id counter so an ack for the chapter just left can never satisfy this one.
      return { ...RESTORE_GATE_INITIAL, chapterSlug: event.chapterSlug, restoreId: state.restoreId }

    case 'restoreIssued':
      return { ...state, phase: 'issued', restoreId: event.restoreId, issuedAt: event.at, staleAck: false }

    case 'nothingToRestore':
      return { ...state, phase: 'open' }

    case 'restoreLanded':
      if (state.phase !== 'issued') return state
      if (event.restoreId !== state.restoreId) return state.staleAck ? state : { ...state, staleAck: true }
      return { ...state, phase: 'open' }

    case 'positionReported':
      if (state.phase !== 'issued' || state.staleAck) return state
      // A non-zero offset is the reader demonstrably somewhere other than the top, whatever put
      // them there — which is the one thing the load event's zero can never be. It stands in for a
      // lost ack. The zero itself, deliberately, opens nothing.
      return event.scrollY > 0 ? { ...state, phase: 'open' } : state

    case 'restoreTimedOut':
      if (state.phase !== 'issued' || event.restoreId !== state.restoreId) return state
      return { ...state, phase: 'open' }

    default:
      return state
  }
}

/** The restore just landed (ack, standby or timeout) — what work deferred until then waits for. */
export function gateOpened(prev: RestoreGateState, next: RestoreGateState): boolean {
  return prev.phase !== 'open' && next.phase === 'open'
}

/** The chapter whose restore has completed, in the shape `canPersistPosition` consumes. */
export function restoredChapter(state: RestoreGateState): string | null {
  return state.phase === 'open' ? state.chapterSlug : null
}
