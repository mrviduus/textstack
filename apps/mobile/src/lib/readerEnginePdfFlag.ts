/**
 * ADR-025 Phase 5 slice 4: an Original-layout PDF is read through the reader engine's fixed layout
 * (`buildPdfEngineHtml`) instead of the old viewer. Its own flag (answer 2b): a PDF rollback must not roll
 * reflow (`EXPO_PUBLIC_READER_ENGINE`) back. Build-time, like every EXPO_PUBLIC_ value; off until the
 * owner's device pass (spike check 8 on device, memory on a 300+ page PDF). Deleted in Phase 6.
 */
export const READER_ENGINE_PDF = process.env.EXPO_PUBLIC_READER_ENGINE_PDF === 'true'
