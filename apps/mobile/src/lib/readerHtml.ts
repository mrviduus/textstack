import { readerFontFaceCss } from './readerFonts'
import { pdfChromeCss } from './pdfViewerChrome'
import { readerChromeCss, type ReaderChrome } from './readerChrome'
import { SCROLL_DIR_DETECTOR } from './readerBridge'
import { READER_ENGINE_SCRIPT } from './readerEngineScript.generated'
import { PDF_JS_SCRIPT, PDF_ENGINE_SCRIPT } from './pdfViewerScript'

export interface ReaderTheme {
  fontSize: number
  lineHeight: number
  fontFamily: string
  textAlign: string
  backgroundColor: string
  textColor: string
}

const defaultTheme: ReaderTheme = {
  fontSize: 20,
  lineHeight: 1.6,
  fontFamily: '"TextStack", Georgia, serif',
  textAlign: 'left',
  backgroundColor: '#ffffff',
  textColor: '#111827',
}

/** Chapter slugs are generated from titles and can contain anything a title
 *  can. This value lands in an HTML attribute, so it is escaped, not trusted. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The reader page's stylesheet: typography, chrome, images, lists, the chapter-end block, selection and
 * vocab colours. Used by the engine page (`buildEngineReaderHtml`).
 */
export function readerStyle(theme: ReaderTheme, chrome: ReaderChrome, fontFace: string): string {
  return `    ${fontFace}
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ${theme.fontFamily};
      font-size: ${theme.fontSize}px;
      line-height: ${theme.lineHeight};
      text-align: ${theme.textAlign};
      ${readerChromeCss(chrome)}
      word-wrap: break-word;
      overflow-wrap: break-word;
      -webkit-text-size-adjust: none;
      -webkit-user-select: text;
      user-select: text;
      -webkit-touch-callout: default;
    }
    /* Aged book edge shadows — matches PWA */
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 9999;
      box-shadow:
        inset 80px 0 60px -60px ${theme.backgroundColor.toUpperCase() === '#1A1A2E'
          ? 'rgba(0,0,0,0.7), inset -80px 0 60px -60px rgba(0,0,0,0.7), inset 0 50px 40px -40px rgba(0,0,0,0.5), inset 0 -50px 40px -40px rgba(0,0,0,0.5)'
          : theme.backgroundColor.toUpperCase() === '#F4ECD8'
            ? 'rgba(50,25,10,0.6), inset -80px 0 60px -60px rgba(50,25,10,0.6), inset 0 50px 40px -40px rgba(50,25,10,0.4), inset 0 -50px 40px -40px rgba(50,25,10,0.4)'
            : 'rgba(30,15,5,0.5), inset -80px 0 60px -60px rgba(30,15,5,0.5), inset 0 50px 40px -40px rgba(30,15,5,0.3), inset 0 -50px 40px -40px rgba(30,15,5,0.3)'};
    }
    img { max-width: 100%; height: auto; cursor: pointer; }
    .ts-img-lightbox {
      position: fixed; inset: 0;
      z-index: 100000;
      background: rgba(0,0,0,0.95);
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 200ms ease-out;
      touch-action: pinch-zoom;
      -webkit-tap-highlight-color: transparent;
    }
    .ts-img-lightbox.open { opacity: 1; pointer-events: auto; }
    .ts-img-lightbox img {
      max-width: 100%; max-height: 100%;
      transform-origin: center center;
      transition: transform 200ms ease-out;
      user-select: none; -webkit-user-select: none;
    }
    .ts-img-lightbox.dragging img { transition: none; }
    .ts-img-lightbox__close {
      position: absolute;
      top: calc(env(safe-area-inset-top, 0px) + 12px);
      right: 16px;
      width: 44px; height: 44px;
      border-radius: 22px; border: 0;
      background: rgba(255,255,255,0.18);
      color: #fff; font-size: 24px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    h1, h2, h3, h4, h5, h6 { margin: 1em 0 0.5em; }
    p { margin: 0.5em 0; }
    /* Links belong to the page, not to a browser. This was a bare colour and
       nothing else, so the UA's default underline came through and an uploaded
       EPUB's internal cross-references rendered as web-blue underlined text over
       warm serif prose. Keeping them tinted but underlined only on the ink colour
       keeps them findable without shouting. */
    a { color: inherit; text-decoration: underline; text-decoration-thickness: 1px;
        text-underline-offset: 2px; text-decoration-color: currentColor; opacity: 0.85; }
    /* No list rules existed at all, which is why a book's own numbered lists lost
       their numbering and its bulleted lists lost their indent. */
    ul, ol { margin: 0.6em 0; padding-left: 1.6em; }
    ul { list-style: disc; }
    ol { list-style: decimal; }
    li { margin: 0.25em 0; }
    li > p { margin: 0.2em 0; }
    blockquote { margin: 0.8em 0 0.8em 1em; padding-left: 0.8em;
                 border-left: 2px solid currentColor; opacity: 0.85; }
    /* End of chapter (window.__tsSetChapterEnd). Inherits the reader's ink, so
       it follows light / sepia / dark without knowing which is on; the one fill
       is the app accent, which reads on all three. */
    .ts-end { margin: 48px 0 24px; text-align: center; font-family: -apple-system, system-ui, sans-serif;
              -webkit-user-select: none; user-select: none; }
    .ts-end hr { border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 0 0 16px; }
    .ts-end__title { font-size: 15px; opacity: 0.6; margin-bottom: 20px; line-height: 1.4; }
    .ts-end__title.done { font-size: 20px; opacity: 1; font-weight: 600; }
    .ts-end button { display: block; width: 100%; font: inherit; color: inherit; background: none;
                     border: 0; border-radius: 12px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .ts-end__next { min-height: 56px; padding: 10px 16px; background: #C4704B !important; color: #fff !important;
                    font-size: 16px; font-weight: 600; line-height: 1.3; }
    .ts-end__next small { display: block; font-size: 12px; font-weight: 400; opacity: 0.85; margin-top: 2px; }
    .ts-end__alt { min-height: 48px; margin-top: 10px; padding: 10px 16px; font-size: 15px;
                   border: 1px solid currentColor !important; opacity: 0.85; }
    .ts-end__prev { margin-top: 14px; padding: 10px 0; font-size: 13px; opacity: 0.6; }
    .ts-end__error { font-size: 14px; margin-top: 12px; opacity: 0.8; }
    .ts-end button:disabled { opacity: 0.5; }

    /* Reflow had no ::selection rule at all — only the PDF viewer did — so a
       native drag-selection was invisible against the warm page. */
    ::selection { background: rgba(196,112,75,0.35); }

    /* CSS Custom Highlight API — vocab underlines (parity with web). */
    ::highlight(vocab-new) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(59,130,246,0.5); }
    ::highlight(vocab-recognition) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(234,179,8,0.5); }
    ::highlight(vocab-recall) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(234,179,8,0.4); }
    ::highlight(vocab-context) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(34,197,94,0.4); }
    ::highlight(vocab-mastered) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(34,197,94,0.25); }
    ::highlight(vocab-active) { text-decoration: underline; text-decoration-thickness: 2px; text-decoration-skip-ink: all; text-underline-offset: 0.18em; text-decoration-color: rgba(59,130,246,0.7); }

    .vocab-translation-overlay { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
    .vocab-translation-overlay__item { position: absolute; top: 0; left: 0; transform: translate3d(0,0,0); white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; font-size: 0.42em; font-style: italic; font-weight: 400; letter-spacing: 0.015em; color: #6b6b6b; opacity: 0.85; line-height: 1; pointer-events: none; user-select: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; will-change: transform; }

    /* Progress tracking via scroll */
`
}

/**
 * The image lightbox (fullscreen, pinch / double-tap zoom, swipe down to close): `window.__tsOpenImage(src, alt)`.
 * Plain JS beside the engine bundle, not in it (the bundle's size budget); shared by both reflow pages.
 */
export const IMAGE_LIGHTBOX = `
    // --- Image lightbox: tap chapter <img> → fullscreen viewer ---
    // Self-contained vanilla JS; no postMessage / native bridge needed.
    // Pinch via touch-action:pinch-zoom on the overlay (overrides global
    // user-scalable=no). Double-tap toggles 1×↔2.5× as fallback for
    // engines that gate pinch-zoom regardless.
    (function(){
      var _lb = null;
      var _lastTap = 0;
      var _swipe = null;

      function close() {
        if (!_lb) return;
        var node = _lb;
        _lb = null;
        node.classList.remove('open');
        setTimeout(function(){ if (node && node.parentNode) node.parentNode.removeChild(node); }, 220);
      }
      // Expose for chapter switches / hard close from RN side if ever needed.
      window.__closeImageLightbox = close;

      function open(src, alt) {
        if (_lb) close();
        var box = document.createElement('div');
        box.className = 'ts-img-lightbox';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        var img = document.createElement('img');
        img.src = src;
        if (alt) img.alt = alt;
        img.draggable = false;
        box.appendChild(img);

        var btn = document.createElement('button');
        btn.className = 'ts-img-lightbox__close';
        btn.setAttribute('aria-label', 'Close image');
        btn.textContent = '×';
        box.appendChild(btn);

        var scale = 1;
        function setScale(s) {
          scale = Math.max(1, Math.min(4, s));
          img.style.transform = 'scale(' + scale + ')';
        }

        // Tap dismiss + double-tap toggle zoom.
        img.addEventListener('click', function(e) {
          e.stopPropagation();
          var now = Date.now();
          if (now - _lastTap < 280) {
            setScale(scale > 1 ? 1 : 2.5);
            _lastTap = 0;
          } else {
            _lastTap = now;
          }
        });
        box.addEventListener('click', function(e) {
          if (e.target === box) close();
        });
        btn.addEventListener('click', function(e) { e.stopPropagation(); close(); });

        // Swipe-down to close (only when not zoomed and gesture starts on overlay).
        box.addEventListener('touchstart', function(e) {
          if (scale > 1) { _swipe = null; return; }
          var t = e.touches && e.touches[0];
          if (!t) return;
          _swipe = { x: t.clientX, y: t.clientY };
        }, { passive: true });
        box.addEventListener('touchmove', function(e) {
          if (!_swipe || scale > 1) return;
          var t = e.touches && e.touches[0];
          if (!t) return;
          var dy = t.clientY - _swipe.y;
          if (dy > 80 && Math.abs(t.clientX - _swipe.x) < 60) {
            _swipe = null;
            close();
          }
        }, { passive: true });
        box.addEventListener('touchend', function(){ _swipe = null; }, { passive: true });

        document.body.appendChild(box);
        // Force reflow before adding .open so transition fires.
        // eslint-disable-next-line no-unused-expressions
        box.offsetHeight;
        box.classList.add('open');
        _lb = box;
      }
      // The engine page opens it from the engine's imageTap.
      window.__tsOpenImage = open;
    })();
`

/**
 * The reflow document with the reader engine (ADR-025 Phase 3): the protocol to RN (`readerEnginePage.ts`), the engine underneath. The chapter waits in
 * an inert <template> (no image loads, no layout) until the engine opens it.
 */
export function buildEngineReaderHtml(chapterHtml: string, theme: ReaderTheme = defaultTheme, chapterSlug = '', safeArea?: { top: number; bottom: number }): string {
  const chrome: ReaderChrome = {
    safeArea: { top: safeArea?.top ?? 0, bottom: safeArea?.bottom ?? 0 },
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  }
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
${readerStyle(theme, chrome, readerFontFaceCss(theme.fontFamily))}
  </style>
</head>
<body>
  <template id="ts-chapter">${chapterHtml}</template>
  <div id="ts-root" data-slug="${escapeAttr(chapterSlug)}"></div>
  <script>${SCROLL_DIR_DETECTOR}${IMAGE_LIGHTBOX}</script>
  <script>${READER_ENGINE_SCRIPT}</script>
</body>
</html>`
}

export interface PdfViewerHtmlOptions {
  theme?: ReaderTheme
  /** 1-based PDF page to open at (chapter start page or resume page). */
  initialPage?: number | null
  safeArea?: { top: number; bottom: number }
}

/**
 * The Original-layout PDF through the reader engine (ADR-025 Phase 5 slice 4):
 * the engine page (`readerEnginePdfPage.ts`, bundled with legacy pdf.js as PDF_ENGINE_SCRIPT) in place of
 * the old viewer. No selection bridge or overlay: the engine selects, holds, taps and paints; only the
 * old scroll-direction detector stays, as on the reflow engine page (RN resyncs it with __tsSetBars).
 * Chrome: `#pdf-root` padding, theme; native pinch zoom. The token is the
 * one the document opens with; a refresh reaches the page over the bridge, never by a rebuild.
 */
export function buildPdfEngineHtml(fileUrl: string, token: string | null, options: PdfViewerHtmlOptions & { local: boolean }): string {
  const theme = options.theme ?? defaultTheme
  const chrome: ReaderChrome = {
    safeArea: { top: options.safeArea?.top ?? 0, bottom: options.safeArea?.bottom ?? 0 },
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  }
  const bootstrap = JSON.stringify({
    url: fileUrl, token, initialPage: options.initialPage ?? null, local: options.local, safeTop: chrome.safeArea.top,
  }).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <!-- Pinch-zoom on here and nowhere else (Phase 5 answer 6a: native pinch, no engine zoom): an A4 page
       fit to a portrait phone is ~6pt, unreadable without zoom. The reflow page keeps user-scalable=no:
       there the font-size control is the zoom. -->
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: none; }
    body { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
    ${pdfChromeCss(chrome)}
    .pdf-page { box-shadow: 0 1px 5px rgba(0,0,0,0.25); }
  </style>
</head>
<body>
  <div id="pdf-root"></div>
  <script>window.__TS_PDF = ${bootstrap};</script>
  <script>${SCROLL_DIR_DETECTOR}</script>
  <script>${PDF_JS_SCRIPT}</script>
  <script>${PDF_ENGINE_SCRIPT}</script>
</body>
</html>`
}
