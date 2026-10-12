// A thin re-export of the reader engine's overlay until Phase 6 (ADR-025, decision D3): web and the
// mobile bundle keep their imports. Relative paths: esbuild bundles mobileBootstrap.ts.
export {
  Overlayer,
  type DrawFn,
  type DrawOptions,
  type WritingMode,
} from '../../reader-engine/src/overlay'
export { textWalker, findTextMatches, findTextOffsets, type MakeRange } from '../../reader-engine/src/textWalker'
