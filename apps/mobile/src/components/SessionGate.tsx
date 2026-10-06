import { useEffect, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import type { EnsureSessionResult } from '../lib/guestSession'
import { readerGateState, READER_SESSION_GATE_TIMEOUT_MS, gateMemory, gateGaveUp } from '../lib/readerSessionGate'

/**
 * Settles the session question BEFORE the thing behind it mounts, then gets out
 * of the way.
 *
 * Wraps the two places where someone commits to keeping something: **opening a
 * book** (progress, highlights, vocabulary — every one of those writes needs a
 * server row) and **uploading one**. Minting at app launch instead would spend
 * a session on people who only browsed the catalog.
 *
 * Upload was added on 2026-09-28, after a device run found a fresh install
 * being offered "Create a free account" on the upload screen. The reasoning
 * recorded there had gone circular: `canUpload` is `hasSession`, and there was
 * no session only because nothing minted one on this path — while a guest is
 * explicitly allowed to upload (ADR-014 §3a). Choosing to upload a book is at
 * least as strong a commitment as opening one.
 *
 * This is a **render** gate rather than an early `ensureSession()` call
 * because `isAuthenticated` is wired into fetch effects, not just display —
 * see the note in `src/lib/readerSessionGate.ts`. Children are passed as
 * elements, so nothing inside them mounts (and no hook inside them runs) until
 * this component actually returns them.
 *
 * The blank is deliberately blank — no spinner. The common case settles in
 * well under 200ms and a spinner that appears and vanishes inside one blink
 * reads as a glitch. On the slow path the reader is about to appear anyway.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { isLoading, ensureSession } = useAuth()
  const { colors } = useTheme()
  const [outcome, setOutcome] = useState<EnsureSessionResult | null>(null)
  // A recent gate already gave up (M4): open at once, and do not mint under the reader.
  const [skipped] = useState(() => gateMemory.skipsWait())
  const [timedOut, setTimedOut] = useState(skipped)
  const startedRef = useRef(skipped)

  // The deadline runs from mount, independently of the request, so a socket
  // that hangs open with no answer cannot keep the book — or the upload —
  // closed.
  useEffect(() => {
    if (skipped) return
    const timer = setTimeout(() => {
      setTimedOut(true)
      gateMemory.record(true)
    }, READER_SESSION_GATE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [skipped])

  useEffect(() => {
    // Runs once per gate mount. `ensureSession` is itself single-flighted, but
    // re-entering here would also reset nothing and cost a render.
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    ensureSession()
      .then((result) => {
        // Recorded even after this gate is gone: it is the network's answer, not the screen's.
        gateMemory.record(gateGaveUp({ outcome: result, timedOut: false }))
        if (!cancelled) setOutcome(result)
      })
      // `ensureSession` is documented never to reject; this is the belt for
      // the day that stops being true. A rejection must still open the book.
      .catch((error: unknown) => { if (!cancelled) setOutcome({ status: 'failed', error }) })
    return () => { cancelled = true }
  }, [ensureSession])

  if (readerGateState({ authLoading: isLoading, outcome, timedOut }) === 'wait') {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />
  }

  return <>{children}</>
}
