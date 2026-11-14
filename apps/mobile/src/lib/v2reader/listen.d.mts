// Types for listen.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SPOKEN_FILL: string
export const TTS_SPEEDS: number[]
export const TTS_SPEED_KEY: string
export function readSpeed(v: unknown): number
export const TTS_VOICES: Record<string, string>
export interface V2TtsVoice { lang: string; voice: string | null }
export function ttsVoice(lang: unknown, fallback?: unknown): V2TtsVoice | null
