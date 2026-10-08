// The engine's contract — ADR-025 (docs/01-architecture/adr/ADR-025-reader-engine-package.md).
// A change here amends that ADR. Types only; nothing implements ReaderEngine yet (Phase 2).
//
// Relative imports, not '@textstack/shared': the mobile WebView gets this package as an esbuild
// IIFE, the same reason packages/reader-overlay imports relatively.
import type { PdfRect } from '../../shared/src/reader/pdfHighlightAnchor'

/** Plain rect, viewport coordinates. DOMRect serialises to {} across the WebView bridge. */
export interface Rect { x: number; y: number; width: number; height: number }

export type StoredKind = 'anchor' | 'position' | 'pdf' | 'progress'

/** Readium Locator + extension fields. */
export interface Locator {
  /** Chapter SLUG, never a chapter id (ADR-015). Absent for a chapterless PDF. */
  href?: string
  type: 'text/html' | 'application/pdf'
  locations: {
    /** Fraction of the chapter, 0..1. */
    progression?: number
    /** Fraction of the book, 0..1 (`percent:<n>`, and the start/end sentinels). */
    totalProgression?: number
    /** PDF page, 1-based. */
    position?: number
    /** Hint, verified, never trusted. */
    charOffset?: number
    /** The old `scroll:<slug>:<px>` locator; read and written until Phase 6. */
    legacyScrollY?: number
  }
  /** W3C Web Annotation TextQuoteSelector. */
  text?: { before?: string; highlight?: string; after?: string }
  ext?: {
    /**
     * The stored value this locator was read from. Written back byte-identically only by the mapper
     * of the same kind, and only while the locator still says what the value says; a moved locator
     * writes a fresh value.
     */
    stored?: { kind: StoredKind; value: string; href?: string }
    rects?: PdfRect[]
  }
}

export interface ChapterDoc {
  href?: string
  layout: 'reflow' | 'fixed'
  /** Reflow: sanitised server HTML. */
  html?: string
  /** Fixed: bytes, or ranges read by the host (which owns auth). */
  pdf?: { data: ArrayBuffer } | { length: number; read(begin: number, end: number): Promise<Uint8Array> }
  lang?: string
  dir?: 'ltr' | 'rtl'
}

export type GoToResult = 'exact' | 'fuzzy' | 'fraction' | 'legacyOffset' | 'start' | 'superseded'

/** Why the reader's place changed. Only 'scroll' (user input after the last op settled) is reading. */
export type Reason = 'open' | 'goTo' | 'style' | 'reflow' | 'scroll'

export interface EngineEvents {
  ready: { opId: string; href?: string; pageCount?: number }
  relocated: { locator: Locator; reason: Reason; opId?: string }
  selection: { locator: Locator; text: string; sentence: string; source: 'hold' | 'drag'; tooLong: boolean; rect: Rect } | null
  /** Fires before the held word resolves (haptic). */
  hold: { x: number; y: number }
  decorationTap: { group: 'highlight' | 'search'; id: string; rect: Rect }
  imageTap: { src: string; alt?: string; rect: Rect }
  tap: { x: number; y: number }
  scrollDir: 'up' | 'down'
  /** The footer came into view; once per open. */
  chapterEnd: { visible: true }
  linkClick: { href: string; internal: boolean }
  error: { code: 'pdf-auth' | 'pdf-load' | 'render' | 'anchor-miss'; detail?: string }
}

export interface Style {
  fontSize?: number
  lineHeight?: number
  family?: string
  fontFaceCss?: string
  align?: 'start' | 'justify'
  theme?: { bg: string; fg: string; link?: string }
  insets?: { top: number; bottom: number }
  /** Fixed layout only. */
  zoom?: number | 'fit'
}

export interface ReaderEngine {
  /** Every open/goTo/setStyle emits exactly one `relocated` with its opId, before resolving. */
  open(doc: ChapterDoc, at?: Locator, opId?: string): Promise<GoToResult>
  goTo(at: Locator, opts?: { align?: 'reading-line' | 'center'; opId?: string }): Promise<GoToResult>
  /** Re-anchors on the text at the reading line; never rebuilds the document. */
  setStyle(s: Style, opId?: string): void
  /** Chapter-end block: in the scroll flow, outside the measured text. */
  setFooter(el: HTMLElement | null): void
  /** Replaces the whole group. */
  decorate(group: 'highlight' | 'search', items: { id: string; locator: Locator; style?: string }[]): void
  markWords(items: { word: string; style?: string; translation?: string }[], showTranslations: boolean): void
  find(query: string): { locator: Locator; context: string }[]
  clearSelection(): void
  /** Web only; mobile keeps the last `relocated`. */
  current(): Locator | null
  on<K extends keyof EngineEvents>(e: K, cb: (p: EngineEvents[K]) => void): () => void
  destroy(): void
}

/** Options exist for tests (jsdom has no layout); hosts pass nothing. */
export interface EngineOptions {
  scroller?: HTMLElement
  measure?: (el: Element) => { top: number; height: number }
  viewport?: () => { height: number }
  schedule?: (cb: () => void) => void
  observeResize?: (el: Element, cb: () => void) => () => void
  fontsReady?: () => Promise<void>
}
