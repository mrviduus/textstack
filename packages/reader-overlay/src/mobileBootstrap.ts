// Mobile WebView entry point. Wraps the shared `Overlayer` class as the
// functional `window.__TSOverlayer` API expected by the injected JS in
// apps/mobile/src/lib/readerHtml.ts.
//
// Bundled by apps/web/scripts/build-mobile-overlay.mjs into a single IIFE
// string emitted to apps/mobile/src/lib/readerOverlayScript.generated.ts.
// Hand-editing that generated file is forbidden — change THIS file instead
// and re-run `pnpm -C apps/web build:mobile-overlay`.
//
// Why a wrapper, not a direct class export:
//   1. readerHtml.ts uses a factory shape (`__TSOverlayer.create()`) plus
//      free draw fns (`__TSOverlayer.highlight`). Keeping that contract
//      means we don't have to touch ~50 callsites in mobile.
//   2. Older Android Chromium WebView (Android 7-9, ~Chromium 51-62) does
//      not support ES private class fields. esbuild downlevels them when
//      we target es2017, but the public surface stays plain functions on
//      a plain object.

import { Overlayer } from './readerOverlay'
import type { DrawFn, DrawOptions } from './readerOverlay'
// Relative, not '@textstack/shared': esbuild bundles this entry and the package
// alias is not configured for it. textAnchor has no imports of its own, so the
// WebView bundle grows by exactly that one leaf module rather than by the whole
// shared index (which would drag the API clients in with it).
import { findAnchorOffset, type TextAnchor } from '../../shared/src/reader/textAnchor'
import { parseTextPosition, resolveTextPosition, type ResolvedPosition } from '../../shared/src/reader/textPosition'

declare global {
  interface Window {
    __TSOverlayer?: TSOverlayerGlobal
    __TSAnchor?: TSAnchorGlobal
  }
}

/**
 * Text-anchor resolution, shared with web.
 *
 * The WebView cannot import modules, so this is the only way a shared function
 * reaches it. Before this, `readerHtml.ts` carried its own resolver — the same
 * idea with integer scoring instead of Dice similarity, and with neither the
 * offset verification nor the fuzzy fallback — so a highlight that survived a
 * book edit on the web silently vanished on the phone.
 */
interface TSAnchorGlobal {
  /** Character offset of `anchor.exact` within `fullText`, or null. */
  findOffset: (fullText: string, anchor: TextAnchor) => number | null
  /** Resolve a serialised reading position. See anchorBootstrap.ts. */
  resolvePosition: (json: string, chapterSlug: string, chapterText: string) => ResolvedPosition | null
}

interface TSOverlayerInstance {
  element: SVGSVGElement
  add: (key: string, range: Range, draw: DrawFn, options?: DrawOptions) => void
  remove: (key: string) => void
  clear: () => void
  redraw: () => void
  syncScroll: () => void
  hitTest: (point: { x: number; y: number }) => [string, Range] | []
  size: () => number
  markJustAnchored: (ms?: number) => void
  isJustAnchored: () => boolean
}

interface TSOverlayerGlobal {
  create: () => TSOverlayerInstance
  highlight: DrawFn
  underline: DrawFn
  outline: DrawFn
  strikethrough: DrawFn
  squiggly: DrawFn
  pulse: DrawFn
}

function adapt(ov: Overlayer): TSOverlayerInstance {
  return {
    element: ov.element,
    add: (key, range, draw, options) => ov.add(key, range, draw, options),
    remove: (key) => ov.remove(key),
    clear: () => ov.clear(),
    redraw: () => ov.redraw(),
    syncScroll: () => ov.syncScroll(),
    hitTest: (point) => ov.hitTest(point),
    size: () => ov.size,
    markJustAnchored: (ms) => ov.markJustAnchored(ms),
    isJustAnchored: () => ov.isJustAnchored(),
  }
}

// Both entry points install this, guarded, so whichever loads first wins — they
// must therefore offer the same surface. anchorBootstrap.ts says why there are two.
if (typeof window !== 'undefined' && !window.__TSAnchor) {
  window.__TSAnchor = {
    findOffset: findAnchorOffset,
    resolvePosition: (json, chapterSlug, chapterText) =>
      resolveTextPosition(parseTextPosition(json), chapterSlug, chapterText),
  }
}

if (typeof window !== 'undefined' && !window.__TSOverlayer) {
  window.__TSOverlayer = {
    create: () => adapt(new Overlayer()),
    highlight: Overlayer.highlight,
    underline: Overlayer.underline,
    outline: Overlayer.outline,
    strikethrough: Overlayer.strikethrough,
    squiggly: Overlayer.squiggly,
    pulse: Overlayer.pulse,
  }
}
