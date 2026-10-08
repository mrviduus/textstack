// Mobile WebView entry point for text-anchor resolution ALONE.
//
// `mobileBootstrap.ts` also installs `window.__TSAnchor`. When that bundle was
// inlined only behind the (since removed) overlay-v2 flag, `hlFindAnchor`
// degraded to a bare `indexOf` without it. The reading position has nowhere else
// to go, so the resolver keeps an entry of its own; `readerHtml.ts` now inlines
// both bundles unconditionally.
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
