// Re-export of the auto-generated PDF viewer bundle. The real source is
// apps/web/scripts/pdfViewer/entry.ts / engineEntry.ts (+ the pdf.js legacy worker); bundling is
// done by apps/web/scripts/build-mobile-pdf.mjs and committed to
// pdfViewerScript.generated.ts so Metro/Expo can import it without a build step.
//
// To change the Original-layout PDF viewer, edit the entry + run:
//   pnpm -C apps/web build:mobile-pdf
export { PDF_JS_SCRIPT, PDF_VIEWER_SCRIPT, PDF_ENGINE_SCRIPT } from './pdfViewerScript.generated'
