export type * from './api'
export * from './mappers'
export { createEngine } from './engine'

// ADR-019 pure rules (pinned in positionRules.test.ts). The code stays in shared (D2; moving it is out of Phase 6, answer 6a).
// Not `readerMovedSince` / `REFLOW_MOVE_TOLERANCE_PX`: with the engine, "moved" = a 'scroll' arrived.
export { serverProvablyNewer, decideNewerPosition, trustedLocalStamp, type NewerPositionAction } from '../../shared/src/reader/newerPosition'
export { localProgressWins, MAX_CLIENT_SKEW_MS } from '../../shared/src/reader/progressPrecedence'
export {
  pdfGateReduce, PDF_GATE_INITIAL, type PdfGateState, type PdfGateEvent, type PdfGatePhase,
} from '../../shared/src/reader/pdfPersistGate'
