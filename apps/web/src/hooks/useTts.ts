import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTtsAudio, fetchTtsTimestamps, TtsRateLimitError, WordTimestamp } from '../api/tts'
import { getCachedTtsAudio, cacheTtsAudio } from '../lib/offlineDb'

// Shared playback element + blob URL — a single TTS stream at a time.
let sharedAudio: HTMLAudioElement | null = null
let currentBlobUrl: string | null = null

// When one useTts instance takes over the shared audio, the previous owner's
// onended/onerror handlers get cleared, so their local isPlaying state would
// be stuck at true. Track the current owner's "I lost the audio" callback so
// the new owner can reset the previous owner's state before taking over.
let currentOwnerReset: (() => void) | null = null

// iOS Safari / mobile Chrome block `audio.play()` outside a user gesture
// (autoplay policy). We auto-play TTS from a useEffect that fires after
// STABILIZE_MS + state update + async fetch — way outside the gesture window.
// To work around: on the first user pointer/touch/key event, play a silent
// data-URI on the shared Audio element to "unlock" it for later programmatic
// plays. After unlock, subsequent `.play()` calls with real src work.
//
// 44-byte empty-PCM WAV (no samples) — enough to satisfy iOS unlock handshake.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
let audioUnlocked = false

function getAudio(): HTMLAudioElement {
  if (!sharedAudio) sharedAudio = new Audio()
  return sharedAudio
}

function unlockAudio() {
  if (audioUnlocked) return
  audioUnlocked = true
  const a = getAudio()
  const prevMuted = a.muted
  a.muted = true
  a.src = SILENT_WAV
  // Synchronous .play() in a user-gesture handler primes the element on iOS.
  // We swallow the promise; both resolve and reject count as the unlock on iOS.
  a.play()
    .catch(() => {})
    .finally(() => {
      a.pause()
      a.muted = prevMuted
    })
}

// Listener attachment is idempotent — call to (re)wire the unlock handlers.
// We re-attach when a programmatic .play() throws NotAllowedError mid-session
// (e.g. user revoked autoplay permission, switched tabs and lost the gesture
// budget on Safari, or the original unlock event happened before the audio
// element existed). Without this re-arm path, audioUnlocked stayed `true`
// and we never tried to prime the element again — every subsequent speak()
// silently failed with 'blocked' until full page reload.
//
// Idempotency guard: addEventListener({once: true}) deduplicates by (type,
// listener, capture) tuple, so double-attaching the SAME function reference
// is a no-op. But to make intent explicit + protect against overlapping
// resetUnlock() calls firing extra handler runs, we gate on a flag.
let unlockListenersAttached = false
function attachUnlockListeners() {
  if (typeof document === 'undefined') return
  if (unlockListenersAttached) return
  unlockListenersAttached = true
  const opts: AddEventListenerOptions = { once: true, passive: true, capture: true }
  const wrapped = () => {
    unlockListenersAttached = false
    unlockAudio()
  }
  document.addEventListener('pointerdown', wrapped, opts)
  document.addEventListener('touchstart', wrapped, opts)
  document.addEventListener('keydown', wrapped, opts)
}

attachUnlockListeners()

function resetUnlock() {
  audioUnlocked = false
  attachUnlockListeners()
}

function cleanup() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = null
  }
}

export type TtsError = 'blocked' | 'failed' | 'rate_limited' | null

/**
 * @param stopKey playback belongs to this key (the reader passes the chapter):
 *   a change stops it, as does unmounting (leaving the page).
 */
export function useTts(stopKey?: unknown) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<TtsError>(null)
  const [retryAfterSeconds, setRetryAfterSeconds] = useState<number | null>(null)
  const [timestamps, setTimestamps] = useState<WordTimestamp[]>([])
  const [currentWordIndex, setCurrentWordIndex] = useState(-1)
  const abortRef = useRef<AbortController | null>(null)
  const rafRef = useRef<number | null>(null)
  // Timestamps kept on a ref so the rAF tick doesn't re-close over stale
  // state. State is still surfaced via `timestamps` for consumers that want
  // to render the word list.
  const timestampsRef = useRef<WordTimestamp[]>([])

  // Stable per-instance callback — used as identity to tell owner-me apart
  // from owner-other-instance in currentOwnerReset.
  const localResetRef = useRef<() => void>(() => {})
  localResetRef.current = () => {
    setIsPlaying(false)
    setIsLoading(false)
  }
  const localReset = useCallback(() => localResetRef.current(), [])

  const stopTracking = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setCurrentWordIndex(-1)
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    const audio = getAudio()
    audio.pause()
    // Detach handlers BEFORE clearing src — setting src='' on an audio element
    // with a loaded source triggers an error event, which would otherwise
    // bubble to onerror and spuriously set error='failed' on user-initiated stop.
    audio.onended = null
    audio.onerror = null
    audio.src = ''
    cleanup()
    stopTracking()
    setIsPlaying(false)
    setIsLoading(false)
    if (currentOwnerReset === localReset) currentOwnerReset = null
  }, [localReset, stopTracking])

  // stopKey change / unmount: cancel our in-flight fetch and silence our audio
  // (the shared element outlives the page). Another instance's playback is left alone.
  useEffect(() => {
    return () => {
      if (currentOwnerReset === localReset) stop()
      else {
        abortRef.current?.abort()
        setIsLoading(false)
      }
    }
  }, [stopKey, localReset, stop])

  const speak = useCallback(async (text: string, lang: string, voice?: string, speed?: number) => {
    // Stop any current playback
    stop()
    // If another instance of useTts currently owns the shared audio, reset
    // its React state — we just detached its onended/onerror above, so its
    // isPlaying flag would otherwise be stuck until next render.
    if (currentOwnerReset && currentOwnerReset !== localReset) {
      const prev = currentOwnerReset
      currentOwnerReset = null
      prev()
    }
    setError(null)
    setRetryAfterSeconds(null)
    setTimestamps([])
    timestampsRef.current = []

    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    try {
      // Try IndexedDB cache first
      let audioData: ArrayBuffer | null = null
      try {
        const cached = await getCachedTtsAudio(lang, text)
        if (cached) audioData = cached.audioData
      } catch { /* ignore cache errors */ }

      if (controller.signal.aborted) return

      // Fetch from API if not cached. Pass signal so abort during fetch
      // actually cancels the network request — otherwise stop() sets the flag
      // but the fetch still downloads to completion (wasted bandwidth).
      if (!audioData) {
        audioData = await fetchTtsAudio(text, lang, voice, speed, controller.signal)
        if (controller.signal.aborted) return
        // Cache for offline
        try { await cacheTtsAudio(lang, text, audioData) } catch { /* ignore */ }
      }

      // Timestamps are cheap on cache hit (same key as audio) — fetch in
      // parallel-ish with audio decode. Failure here is non-fatal: if the
      // timestamps endpoint fails we still play audio without highlighting.
      // IndexedDB is NOT used for timestamps today — the HTTP ETag/304 path
      // is sufficient given the small JSON payload.
      fetchTtsTimestamps(text, lang, voice, speed, controller.signal)
        .then(ts => {
          if (controller.signal.aborted) return
          timestampsRef.current = ts
          setTimestamps(ts)
        })
        .catch(() => { /* non-fatal */ })

      if (controller.signal.aborted) return

      // Play
      cleanup()
      const blob = new Blob([audioData], { type: 'audio/mpeg' })
      currentBlobUrl = URL.createObjectURL(blob)
      const audio = getAudio()
      audio.src = currentBlobUrl

      audio.onended = () => {
        setIsPlaying(false)
        cleanup()
        stopTracking()
        if (currentOwnerReset === localReset) currentOwnerReset = null
      }
      audio.onerror = () => {
        // Mid-playback failure: expose it to UI. Without setError, the popup
        // just goes silent with no indicator — user thinks it worked.
        setIsPlaying(false)
        cleanup()
        stopTracking()
        setError('failed')
        if (currentOwnerReset === localReset) currentOwnerReset = null
      }

      // Claim ownership of the shared audio right before playing. A later
      // speak() from another instance will see us as the owner and notify
      // us via localReset before hijacking.
      currentOwnerReset = localReset
      setIsLoading(false)
      setIsPlaying(true)

      // Track currentWordIndex via rAF. Linear scan from `lastIndex` rather
      // than bisecting — audio plays forward, so the scan is O(1) per frame.
      // We don't tick from `timeupdate`: that fires at only ~4Hz in Chrome
      // and would lag behind visible word changes.
      let lastIndex = -1
      const tick = () => {
        const nowMs = audio.currentTime * 1000
        const ts = timestampsRef.current
        if (ts.length > 0) {
          let idx = lastIndex < 0 ? 0 : lastIndex
          // Advance while next words are due.
          while (idx < ts.length - 1 && ts[idx + 1].startMs <= nowMs) idx++
          // Before first word starts → -1 so nothing is highlighted during
          // the leading silence.
          if (nowMs < ts[0].startMs) idx = -1
          if (idx !== lastIndex) {
            lastIndex = idx
            setCurrentWordIndex(idx)
          }
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      try {
        await audio.play()
      } catch (err) {
        // NotAllowedError = browser blocked autoplay (no user gesture yet, or unlock missed).
        const name = (err as { name?: string })?.name
        setIsPlaying(false)
        cleanup()
        stopTracking()
        setError(name === 'NotAllowedError' ? 'blocked' : 'failed')
        // Re-arm the unlock path so the next user gesture tries again. Without
        // this, audioUnlocked stays true after a permission revoke and every
        // subsequent speak() fails the same way until full reload.
        if (name === 'NotAllowedError') resetUnlock()
        if (currentOwnerReset === localReset) currentOwnerReset = null
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('TTS error:', err)
        setIsLoading(false)
        setIsPlaying(false)
        stopTracking()
        if (err instanceof TtsRateLimitError) {
          setRetryAfterSeconds(err.retryAfterSeconds)
          setError('rate_limited')
        } else {
          setError('failed')
        }
      }
    }
  }, [stop, localReset, stopTracking])

  return { speak, stop, isPlaying, isLoading, error, retryAfterSeconds, timestamps, currentWordIndex }
}
