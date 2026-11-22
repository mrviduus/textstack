// Whether the session bootstrap has settled (AuthContext): until then the V2 switch waits instead of
// answering off. Its own module, importing nothing, so the test setup can settle it without loading
// the API client before a test mocks it.
let settle: () => void = () => {}
let settled: Promise<void> = new Promise((r) => { settle = r })

/** The bootstrap ended (with or without a user), or a session started the probe. */
export const settleSyncSession = () => settle()

export const syncSessionSettled = () => settled

/** Tests only: a fresh app start, before the bootstrap. */
export function rearmSyncSession() {
  settled = new Promise((r) => { settle = r })
}
