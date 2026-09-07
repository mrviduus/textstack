/**
 * The reflow reader's chrome — safe-area padding and theme colours — and the
 * rule about what may rebuild its document.
 *
 * Same defect the PDF viewer had, found while fixing that one. `buildReaderHtml`
 * takes safe-area insets, and the reader renders `<StatusBar hidden={!barsVisible}>`;
 * on Android hiding the status bar changes `insets.top`. `useReaderBars` hides
 * the bars three seconds after open and toggles them on every change of scroll
 * direction. So the HTML string changed, the WebView reloaded, and the document
 * was rebuilt many times per session with no user action.
 *
 * It is invisible here in a way it was not in the PDF, because
 * `useReaderPersistence` restores the scroll position on load — so the reader
 * sees a flicker rather than a jump. What does not survive is everything the
 * document accumulated since it loaded: chapters appended by infinite scroll are
 * thrown away and re-fetched, and the vocab marks and highlights painted over
 * them have to be pushed again.
 *
 * **Typography is here now too.** It used to be a document input on the grounds
 * that a rebuild plus the existing scroll restore was "the behaviour those
 * settings already have". It was not. The restore that ran after a typography
 * rebuild re-applied the reader's CURRENT chapter fraction to a document
 * rebuilt from the ROUTE chapter — so a reader 55% into chapter two, appended
 * by infinite scroll, was moved to 74% of chapter one, and the debounced save
 * then wrote that over their real position. Font size, line height, alignment
 * and the serif/sans family are ordinary CSS and are applied to the live
 * document by `readerTypographyInjectionJs`, exactly as padding and colour are.
 *
 * What stays a document input is the `@font-face`: OpenDyslexic is 150KB of
 * inlined base64 that `buildFontFace` emits only when it is selected, and
 * putting it in every document to save a rare rebuild is the wrong trade.
 * `fontFaceKey` is what the key carries, so serif↔sans costs nothing and only
 * a move to or from the dyslexic face rebuilds.
 */

export interface ReaderChrome {
  safeArea: { top: number; bottom: number }
  backgroundColor: string
  textColor: string
}

/** Horizontal page margin, and the extra breathing room above and below. */
const SIDE_PADDING = 16
const EDGE_PADDING = 16

function paddingValue(c: ReaderChrome): string {
  const top = (c.safeArea.top ?? 0) + EDGE_PADDING
  const bottom = (c.safeArea.bottom ?? 0) + EDGE_PADDING
  return `${top}px ${SIDE_PADDING}px ${bottom}px ${SIDE_PADDING}px`
}

/** CSS for a document being built. */
export function readerChromeCss(c: ReaderChrome): string {
  return `color: ${c.textColor};
      background: ${c.backgroundColor};
      padding: ${paddingValue(c)};`
}

/** The same values applied to a document already on screen. */
export function readerChromeInjectionJs(c: ReaderChrome): string {
  return `(function(){var b=document.body;if(!b)return;` +
    `b.style.padding=${JSON.stringify(paddingValue(c))};` +
    `b.style.background=${JSON.stringify(c.backgroundColor)};` +
    `b.style.color=${JSON.stringify(c.textColor)};` +
    `})()`
}

export interface ReaderTypography {
  fontFamily: string
  fontSize: number
  lineHeight: number
  textAlign: string
}

/** The four declarations that differ between two typographies. */
function typographyDecls(t: ReaderTypography): string {
  return `font-family: ${t.fontFamily};
      font-size: ${t.fontSize}px;
      line-height: ${t.lineHeight};
      text-align: ${t.textAlign};`
}

/** CSS for a document being built. */
export function readerTypographyCss(t: ReaderTypography): string {
  return typographyDecls(t)
}

/**
 * The same values applied to a document already on screen.
 *
 * Not a bare style assignment like the chrome injection. Changing typography
 * reflows the text, which invalidates both the reader's scroll position and
 * every recorded chapter top — so the restyle cannot be a fire-and-forget
 * mutation. It is handed to `__textstackApplyTypography`, which measures where
 * the reader is, restyles, recomputes the tops and puts the same chapter
 * fraction back under the reading line, acknowledging `restoreId` when it
 * lands. The write gate stays shut for that whole window. See readerHtml.ts.
 */
export function readerTypographyInjectionJs(t: ReaderTypography, restoreId: number): string {
  const css = `body{${typographyDecls(t)}}`
  return `window.__textstackApplyTypography && window.__textstackApplyTypography(${JSON.stringify(css)}, ${restoreId})`
}

export function readerTypographyChanged(a: ReaderTypography | null, b: ReaderTypography): boolean {
  if (!a) return true
  return a.fontFamily !== b.fontFamily
    || a.fontSize !== b.fontSize
    || a.lineHeight !== b.lineHeight
    || a.textAlign !== b.textAlign
}

/**
 * The identity of a reflow document. Insets, colours and typography are absent
 * on purpose — that absence is the fix, and an absence is what a reviewer stops
 * seeing. What remains is what genuinely cannot be injected: the chapter the
 * document was built from, whether the overlay script was emitted into it, and
 * whether the OpenDyslexic `@font-face` was inlined.
 */
export function readerDocumentKey(d: {
  chapterSlug: string
  /** 'dyslexic' when the document must carry an inlined @font-face, else 'std'.
   *  NOT the family itself: serif↔sans is pure CSS and is injected. */
  fontFaceKey: string
  overlayV2: boolean
  /** Length is enough to notice a different chapter without hashing it. */
  htmlLength: number
}): string {
  return [
    d.chapterSlug, d.fontFaceKey, d.overlayV2 ? 'v2' : 'v1', String(d.htmlLength),
  ].join(' ')
}

/** Which documents need the inlined face. Mirrors `buildFontFace`. */
export function fontFaceKey(fontFamily: string): string {
  return fontFamily.includes('OpenDyslexic') ? 'dyslexic' : 'std'
}

/** Insets latch to the largest seen — the top bar is an overlay that comes back. */
export function latchReaderChrome(prev: ReaderChrome | null, next: ReaderChrome): ReaderChrome {
  if (!prev) return next
  return {
    safeArea: {
      top: Math.max(prev.safeArea.top, next.safeArea.top),
      bottom: Math.max(prev.safeArea.bottom, next.safeArea.bottom),
    },
    backgroundColor: next.backgroundColor,
    textColor: next.textColor,
  }
}

export function readerChromeChanged(a: ReaderChrome | null, b: ReaderChrome): boolean {
  if (!a) return true
  return a.safeArea.top !== b.safeArea.top
    || a.safeArea.bottom !== b.safeArea.bottom
    || a.backgroundColor !== b.backgroundColor
    || a.textColor !== b.textColor
}
