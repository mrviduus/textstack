// Types for openTracker.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export interface OpenedMessage { book?: { sha256?: string; name?: string } }
export interface Take<O, M> { open: O; opened: M; dropped: O[] }
export interface OpenTracker<O, M extends OpenedMessage> {
  open(name: string, open: O): void
  opened(m: M): Take<O, M> | null
  failed(name: string): { failed: O; take: Take<O, M> | null } | null
  restored(m: { key?: string }): boolean
}
export function createOpenTracker<O, M extends OpenedMessage = OpenedMessage>(): OpenTracker<O, M>
