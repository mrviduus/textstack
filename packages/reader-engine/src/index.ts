export type * from './api'
export * from './mappers'
export { createEngine, type EngineCore } from './engine'

// ADR-019 pure rules (pinned in positionRules.test.ts). The code stays in shared until Phase 6 (D2).
// Not `readerMovedSince` / `REFLOW_MOVE_TOLERANCE_PX`: with the engine, "moved" = a 'scroll' arrived.
export { serverProvablyNewer, decideNewerPosition, trustedLocalStamp, type NewerPositionAction } from '../../shared/src/reader/newerPosition'
export { localProgressWins, MAX_CLIENT_SKEW_MS } from '../../shared/src/reader/progressPrecedence'
export * from '../../shared/src/reader/pdfPersistGate'
