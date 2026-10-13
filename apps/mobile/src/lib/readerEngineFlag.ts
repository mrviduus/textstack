/**
 * ADR-025 Phase 3: reflow chapters are read through the reader engine (`buildEngineReaderHtml`).
 * Build-time, like every EXPO_PUBLIC_ value: set in the EAS environment, it reaches every build on the
 * channel with the next OTA; rollback is the same OTA with it unset (~15 min). Off until the engine page
 * covers selection, highlights and vocab (Phase 3 slices 3–4) and QA-007 passes with it on.
 */
export const READER_ENGINE = process.env.EXPO_PUBLIC_READER_ENGINE === 'true'
