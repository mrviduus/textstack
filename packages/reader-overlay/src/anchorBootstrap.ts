// Mobile WebView entry point for text-anchor resolution ALONE.
//
// `mobileBootstrap.ts` already installs `window.__TSAnchor` — but that bundle is
// inlined only when the overlay-v2 flag is on (`readerHtml.ts` emits it
// conditionally), and the flag is a per-device override that can be off. With it
// off, `hlFindAnchor` degrades to a bare `indexOf`: no context ladder, no offset
// verification, no fuzzy fallback.
//
// That was survivable for highlights, which have a legacy `<mark>` path behind
// them. It is not survivable for the reading position, which is resolved from an
// anchor on every chapter open and has nowhere else to go. So the resolver gets
// an entry of its own, always inlined, and the overlay bundle keeps meaning
// exactly what it means.
//
// Both bundles guard on `!window.__TSAnchor`, so loading both installs one.
//
// Bundled by apps/web/scripts/build-mobile-overlay.mjs into
// apps/mobile/src/lib/readerAnchorScript.generated.ts. Hand-editing that file is
// forbidden — change THIS file and re-run `pnpm -C apps/web build:mobile-overlay`.

// Relative, not '@textstack/shared': esbuild bundles this entry and the package
// alias is not configured for it. textAnchor has no imports of its own, so the
// bundle is exactly that one leaf module.
import { findAnchorOffset, type TextAnchor } from '../../shared/src/reader/textAnchor'
import { parseTextPosition, resolveTextPosition, type ResolvedPosition } from '../../shared/src/reader/textPosition'

declare global {
  interface Window {
    __TSAnchor?: {
      findOffset: (fullText: string, anchor: TextAnchor) => number | null
      /**
       * Resolve a serialised reading position against the text on screen.
       *
       * Exposed rather than reimplemented inside the WebView's inline script:
       * the resolution ladder — anchor, then the offset tie-break for a passage
       * that repeats, then the chapter fraction — is the part with the
       * judgement in it, and the whole reason `textAnchor` lives in shared is
       * that this codebase has already paid for two copies of a resolver that
       * disagreed.
       */
      resolvePosition: (json: string, chapterSlug: string, chapterText: string) => ResolvedPosition | null
    }
  }
}

if (typeof window !== 'undefined' && !window.__TSAnchor) {
  window.__TSAnchor = {
    findOffset: findAnchorOffset,
    resolvePosition: (json, chapterSlug, chapterText) =>
      resolveTextPosition(parseTextPosition(json), chapterSlug, chapterText),
  }
}

export {}
