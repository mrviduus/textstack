// Types for listen.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const SPOKEN_FILL: string
export const TTS_SPEEDS: number[]
export const TTS_SPEED_KEY: string
export function readSpeed(v: unknown): number
export function createSpeedChoice(store: { load: () => Promise<unknown> | unknown; save: (v: string) => void; show: (speed: number) => void }): (v: number) => void
export function ttsLang(lang: unknown, fallback?: unknown): string | null
export type TtsPhase = 'idle' | 'loading' | 'playing'
export interface SpokenAt { cfi: string | null; index: number }
export interface Spoken { text: string; at: SpokenAt | null }
export interface Listener {
  press(spoken: Spoken | null): void
  stop(): void
  follow(open: Spoken | null): void
  state(spoken: Spoken | null): TtsPhase
}
export function spokenOf(popup: unknown): Spoken | null
export function createListener(host: {
  speak: (text: string, done: (failed?: boolean) => void) => Promise<boolean> | boolean
  stop: () => void
  mark: (at: SpokenAt | null) => void
  changed?: () => void
  failed?: () => void
}): Listener
export function speakingJs(at: SpokenAt | null): string
