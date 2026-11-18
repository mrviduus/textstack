// Types for listen.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SPOKEN_FILL: string
export const TTS_SPEEDS: number[]
export const TTS_SPEED_KEY: string
export function readSpeed(v: unknown): number
export function createSpeedChoice(store: { load: () => Promise<unknown> | unknown; save: (v: string) => void; show: (speed: number) => void }): (v: number) => void
export function ttsLang(lang: unknown, fallback?: unknown): string | null
export type V2TtsPhase = 'idle' | 'loading' | 'playing'
export interface V2SpokenAt { cfi: string | null; index: number }
export interface V2Spoken { text: string; at: V2SpokenAt | null }
export interface V2Listener {
  press(spoken: V2Spoken | null): void
  stop(): void
  follow(open: V2Spoken | null): void
  state(spoken: V2Spoken | null): V2TtsPhase
}
export function spokenOf(popup: unknown): V2Spoken | null
export function createListener(host: {
  speak: (text: string, done: (failed?: boolean) => void) => Promise<boolean> | boolean
  stop: () => void
  mark: (at: V2SpokenAt | null) => void
  changed?: () => void
  failed?: () => void
}): V2Listener
export function speakingJs(at: V2SpokenAt | null): string
