// Types for listen.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SPOKEN_FILL: string
export const TTS_SPEEDS: number[]
export const TTS_SPEED_KEY: string
export function readSpeed(v: unknown): number
export const TTS_VOICES: Record<string, string>
export interface V2TtsVoice { lang: string; voice: string | null }
export function ttsVoice(lang: unknown, fallback?: unknown): V2TtsVoice | null
export function speakingJs(at: { cfi: string | null; index: number } | null): string
export type V2TtsPhase = 'idle' | 'loading' | 'playing'
export interface V2SpokenAt { cfi: string | null; index: number }
export interface V2Listener {
  press(text: string, at: V2SpokenAt): void
  phase(p: V2TtsPhase): void
  speaking(text: string): boolean
}
export function createListener(host: { speak: (text: string) => Promise<boolean> | boolean; stop: () => void; mark: (at: V2SpokenAt | null) => void }): V2Listener
