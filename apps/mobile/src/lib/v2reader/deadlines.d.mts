// Types for deadlines.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type Overdue = 'ready' | 'opened' | null
export const READY_DEADLINE_MS: number
export const READY_DEADLINE_NETWORK_MS: number
export const OPENED_FLOOR_MS: number
export const OPENED_MS_PER_MB: number
export const OPENED_CAP_MS: number
export function openedDeadlineMs(bytes: number | null | undefined): number
export interface Deadlines {
  waitReady(ms: number): void
  ready(): void
  waitOpened(bytes: number | null | undefined): void
  answered(): void
  overdue(): Overdue
  dispose(): void
}
export function createDeadlines(onChange: (overdue: Overdue) => void): Deadlines
