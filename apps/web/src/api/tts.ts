import { noteTtsStatus } from '@textstack/shared'
import { API_BASE } from './client'

export function getTtsAudioUrl(text: string, lang: string, voice?: string, speed?: number): string {
  const params = new URLSearchParams({ text, lang })
  if (voice) params.set('voice', voice)
  if (speed && speed !== 1.0) params.set('speed', String(speed))
  return `${API_BASE}/tts?${params}`
}

export class TtsRateLimitError extends Error {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(`TTS rate limited, retry after ${retryAfterSeconds}s`)
    this.name = 'TtsRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export async function fetchTtsAudio(
  text: string,
  lang: string,
  voice?: string,
  speed?: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const url = getTtsAudioUrl(text, lang, voice, speed)
  const res = await fetch(url, { signal })
  if (res.status === 429) {
    // Server sends Retry-After (seconds) via RateLimiter.OnRejected.
    // Parse it so callers can back off instead of hammering.
    const header = res.headers.get('Retry-After')
    const seconds = header ? parseInt(header, 10) : NaN
    throw new TtsRateLimitError(Number.isFinite(seconds) && seconds > 0 ? seconds : 60)
  }
  noteTtsStatus(lang, res.status) // #1347: a 422 hides Listen for lang
  if (!res.ok) throw new Error(`TTS error: ${res.status}`)
  return res.arrayBuffer()
}

export interface TtsVoiceInfo {
  name: string
  shortName: string
  gender: string
  locale: string
  language: string
}

export async function fetchTtsVoices(lang?: string): Promise<TtsVoiceInfo[]> {
  const params = lang ? `?lang=${lang}` : ''
  const res = await fetch(`${API_BASE}/tts/voices${params}`)
  if (!res.ok) throw new Error(`Failed to fetch voices: ${res.status}`)
  return res.json()
}

// ASP.NET's default JSON serializer camelCases record properties, so the
// wire format already matches our idiomatic WordTimestamp shape — no mapping
// needed. (If the server ever flips to PascalCase we'd re-introduce a
// normalizer here.)
export interface WordTimestamp {
  word: string
  startMs: number
  durationMs: number
}

export async function fetchTtsTimestamps(
  text: string,
  lang: string,
  voice?: string,
  speed?: number,
  signal?: AbortSignal,
): Promise<WordTimestamp[]> {
  const params = new URLSearchParams({ text, lang })
  if (voice) params.set('voice', voice)
  if (speed && speed !== 1.0) params.set('speed', String(speed))
  const res = await fetch(`${API_BASE}/tts/timestamps?${params}`, { signal })
  if (res.status === 429) {
    const header = res.headers.get('Retry-After')
    const seconds = header ? parseInt(header, 10) : NaN
    throw new TtsRateLimitError(Number.isFinite(seconds) && seconds > 0 ? seconds : 60)
  }
  if (!res.ok) throw new Error(`TTS timestamps error: ${res.status}`)
  return res.json() as Promise<WordTimestamp[]>
}
