import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '../lib/api'
import { ttsRequestDecision, TtsPhase } from '../lib/ttsRequest'

// Lazy + safe loads — these native modules ship with the dev build only
// after their respective `expo install`. An older dev build (before the
// TTS migration) doesn't have ExpoAudio bundled, and a bare `import`
// throws at module evaluation time → entire reader screen crashes.
// Wrapping in try/catch lets the rest of the app render and TTS just
// no-ops until the user updates to a build that includes the modules.
type AudioPlayerLike = {
  play: () => void
  pause: () => void
  setPlaybackRate?: (rate: number) => void
  addListener: (event: string, fn: (status: { didJustFinish?: boolean }) => void) => void
  remove?: () => void
}
type ExpoAudioModule = {
  createAudioPlayer: (src: unknown) => AudioPlayerLike
  setAudioModeAsync: (mode: { playsInSilentMode?: boolean; allowsRecording?: boolean }) => Promise<void>
}
type FileSystemModule = {
  cacheDirectory: string | null
  getInfoAsync: (uri: string) => Promise<{ exists?: boolean; size?: number }>
  makeDirectoryAsync: (uri: string, options?: { intermediates?: boolean }) => Promise<void>
  downloadAsync: (url: string, uri: string) => Promise<{ status: number }>
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>
}

let expoAudio: ExpoAudioModule | null = null
let fileSystem: FileSystemModule | null = null
let nativeLoadAttempted = false
function loadNativeOnce(): { audio: ExpoAudioModule | null; fs: FileSystemModule | null } {
  if (nativeLoadAttempted) return { audio: expoAudio, fs: fileSystem }
  nativeLoadAttempted = true
  try { expoAudio = require('expo-audio') as ExpoAudioModule }
  catch (e) { if (__DEV__) console.warn('[tts] expo-audio not available:', (e as Error)?.message) }
  try { fileSystem = require('expo-file-system/legacy') as FileSystemModule }
  catch (e) { if (__DEV__) console.warn('[tts] expo-file-system not available:', (e as Error)?.message) }
  return { audio: expoAudio, fs: fileSystem }
}

/**
 * Maps our app language codes to BCP-47 identifiers passed through to
 * the backend /api/tts endpoint. The backend picks an Edge TTS voice
 * appropriate for the locale (see TtsEndpoints.cs).
 */
function toBcp47(lang?: string): string {
  if (!lang) return 'en-US'
  const lc = lang.toLowerCase()
  if (lc.startsWith('en')) return 'en-US'
  if (lc.includes('-')) return lang
  return 'en-US'
}

/** Cheap deterministic 32-bit djb2 hash used as a filename component. Combined
 *  with the input length for collision resistance — two different strings would
 *  need identical hash AND identical length to share a cache file. */
function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return (h >>> 0).toString(16) + '-' + s.length.toString(16)
}

let cacheDirReady: Promise<void> | null = null
function cacheDir(fs: FileSystemModule): string {
  return `${fs.cacheDirectory ?? ''}tts/`
}
async function ensureCacheDir(fs: FileSystemModule) {
  if (cacheDirReady) return cacheDirReady
  cacheDirReady = (async () => {
    try {
      const dir = cacheDir(fs)
      const info = await fs.getInfoAsync(dir)
      if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true })
    } catch {
      // Best-effort — if FS is unavailable we still attempt downloads to the
      // app's cache root inline below.
    }
  })()
  return cacheDirReady
}

async function audioModeReady(audio: ExpoAudioModule) {
  // playsInSilentMode=true so iOS silent-switch doesn't kill word/sentence
  // playback during reading. Mirrors apps/web autoplay-unlock heuristic.
  try {
    await audio.setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })
  } catch {
    // No-op — module may not be available in test contexts.
  }
}

/** Resolve the on-disk path for a cached MP3, downloading if needed. Returns
 *  null on download failure so the caller can degrade gracefully. */
async function getOrFetchAudio(fs: FileSystemModule, text: string, lang: string, rate: number): Promise<string | null> {
  await ensureCacheDir(fs)
  const dir = cacheDir(fs)
  const speed = rate.toFixed(2)
  const cacheKey = hashKey(`${lang}|${speed}|${text}`)
  const file = `${dir}${cacheKey}.mp3`
  try {
    const info = await fs.getInfoAsync(file)
    if (info.exists && info.size && info.size > 0) return file
  } catch {
    // Treat read errors as cache miss; we'll attempt to download below.
  }
  const url = `${API_URL}/tts?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}&speed=${encodeURIComponent(speed)}`
  try {
    const res = await fs.downloadAsync(url, file)
    if (res.status >= 200 && res.status < 300) return file
    // Non-2xx: clean the bogus file so the next call retries fresh.
    await fs.deleteAsync(file, { idempotent: true }).catch(() => {})
    return null
  } catch {
    await fs.deleteAsync(file, { idempotent: true }).catch(() => {})
    return null
  }
}

export interface TtsSpeakOptions {
  lang?: string
  rate?: number
}

export function useTts() {
  // Three phases, not one boolean. 'loading' covers the ~1s fetch before any
  // sound, which the UI has to be able to show — without it a reader presses
  // Listen, hears nothing, presses again, and cancels their own playback.
  const [phase, setPhase] = useState<TtsPhase>('idle')
  // Text being fetched or played. `toggle` compares against it to tell "stop
  // this" from "play that instead"; see lib/ttsRequest.ts.
  const currentTextRef = useRef<string | null>(null)
  // One player instance per hook usage. createAudioPlayer (vs useAudioPlayer)
  // gives us direct control over replace/release without a re-render cycle.
  const playerRef = useRef<AudioPlayerLike | null>(null)
  // Monotonic counter — every new speak() call invalidates any pending
  // download from a previous call, so the user's latest word wins races.
  const reqRef = useRef(0)

  const releasePlayer = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    try {
      p.pause()
      ;(p as { remove?: () => void }).remove?.()
    } catch {
      // ignore release errors
    }
    playerRef.current = null
  }, [])

  const stop = useCallback(() => {
    // Bump req so any in-flight download knows it's stale.
    reqRef.current++
    releasePlayer()
    currentTextRef.current = null
    setPhase('idle')
  }, [releasePlayer])

  const speak = useCallback(
    async (text: string, opts: TtsSpeakOptions | number = {}) => {
      const trimmed = text.trim()
      if (!trimmed) return
      // If the dev/prod build was assembled before expo-audio /
      // expo-file-system landed, just no-op cleanly — the rest of the
      // reader keeps working.
      const { audio, fs } = loadNativeOnce()
      if (!audio || !fs) return
      const normalized: TtsSpeakOptions = typeof opts === 'number' ? { rate: opts } : opts
      const rate = normalized.rate ?? 1.0
      const bcp47 = toBcp47(normalized.lang)
      const req = ++reqRef.current

      // Tear down any current playback before starting another download —
      // bites the same race a speech API's stop() handles, just made explicit.
      releasePlayer()
      currentTextRef.current = trimmed
      setPhase('loading')

      await audioModeReady(audio)
      const file = await getOrFetchAudio(fs, trimmed, bcp47, rate)
      // Another speak() ran while we were downloading — drop this one.
      if (req !== reqRef.current) return
      if (!file) {
        currentTextRef.current = null
        setPhase('idle')
        return
      }

      try {
        const player = audio.createAudioPlayer(file)
        playerRef.current = player
        try { player.setPlaybackRate?.(1.0) } catch { /* rate already baked in by server */ }
        player.addListener('playbackStatusUpdate', status => {
          if (status.didJustFinish) {
            currentTextRef.current = null
            setPhase('idle')
            releasePlayer()
          }
        })
        // Phase before play(), not after. The listener above is already
        // attached, so a clip short enough to finish inside play() would set
        // 'idle' and then be overwritten back to 'playing' — leaving a Stop
        // button with no player behind it. This way the listener wins.
        setPhase('playing')
        player.play()
      } catch {
        currentTextRef.current = null
        setPhase('idle')
        releasePlayer()
      }
    },
    [releasePlayer],
  )

  const toggle = useCallback(
    (text: string, opts: TtsSpeakOptions | number = {}) => {
      const decision = ttsRequestDecision({
        phase,
        currentText: currentTextRef.current,
        requestedText: text,
      })
      if (decision === 'stop') stop()
      else if (decision === 'start') void speak(text, opts)
    },
    [phase, speak, stop],
  )

  useEffect(() => {
    return () => {
      reqRef.current++
      releasePlayer()
    }
  }, [releasePlayer])

  return {
    speak,
    stop,
    toggle,
    phase,
    /** Fetching audio — no sound yet. Show a spinner, not a play icon. */
    isLoading: phase === 'loading',
    /** Busy in either sense, so a press is a stop. Kept for existing callers. */
    isSpeaking: phase !== 'idle',
  }
}
