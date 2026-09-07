import { openDyslexicBase64 } from './openDyslexicBase64'
import { pdfChromeCss, type PdfChrome } from './pdfViewerChrome'
import { readerChromeCss, type ReaderChrome } from './readerChrome'
import { READER_OVERLAY_SCRIPT } from './readerOverlayScript'
import { READER_SELECTION_BRIDGE } from './readerBridge'
import { PDF_VIEWER_SCRIPT } from './pdfViewerScript'

export interface ReaderTheme {
  fontSize: number
  lineHeight: number
  fontFamily: string
  textAlign: string
  backgroundColor: string
  textColor: string
}

export interface ReaderHtmlOptions {
  // Slice 8b — opt-in SVG overlayer for user highlights. Vocab underlines
  // stay on CSS.highlights (glyph-aware text-decoration beats SVG rects).
  // Default off until device verification + mobile E2E land.
  overlayV2?: boolean
}

const defaultTheme: ReaderTheme = {
  fontSize: 18,
  lineHeight: 1.65,
  fontFamily: 'Georgia, serif',
  textAlign: 'left',
  backgroundColor: '#ffffff',
  textColor: '#111827',
}

/** Chapter slugs are generated from titles and can contain anything a title
 *  can. This value lands in an HTML attribute, so it is escaped, not trusted. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildFontFace(fontFamily: string): string {
  if (!fontFamily.includes('OpenDyslexic')) return ''
  return `@font-face {
    font-family: 'OpenDyslexic';
    src: url(data:font/woff2;base64,${openDyslexicBase64}) format('woff2');
    font-weight: normal;
    font-style: normal;
  }`
}

export function buildReaderHtml(chapterHtml: string, theme: ReaderTheme = defaultTheme, initialChapterSlug?: string, safeArea?: { top: number; bottom: number }, options?: ReaderHtmlOptions): string {
  const fontFace = buildFontFace(theme.fontFamily)
  // Chrome comes from the same values `readerChromeInjectionJs` later applies to
  // the LIVE document, so hiding the bars or switching theme no longer has to
  // rebuild this string — a rebuild reloads the WebView and throws away every
  // chapter infinite scroll appended. See readerChrome.ts.
  const chrome: ReaderChrome = {
    safeArea: { top: safeArea?.top ?? 0, bottom: safeArea?.bottom ?? 0 },
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  }
  const overlayV2 = options?.overlayV2 === true
  // Only inline the overlayer script when flag is on — zero bytes otherwise.
  const overlayScript = overlayV2 ? READER_OVERLAY_SCRIPT : ''
  const overlayFlagSetter = overlayV2 ? 'window.__textstackOverlayV2Mobile = true;' : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${fontFace}
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
    .chapter-separator {
      text-align: center;
      padding: 40px 16px;
      opacity: 0.5;
    }
    .chapter-separator hr {
      border: none;
      border-top: 1px solid currentColor;
      margin-bottom: 12px;
    }

    /* The tapped word, marked for as long as its toolbar is open. This was a
       0.6s fade-out, so the word went dark while the toolbar stayed up and
       nothing said which word it belonged to. */
    .ts-word-mark {
      background-color: rgba(196,112,75,0.35);
      border-radius: 2px;
    }
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
    ::highlight(rag-citation) { background-color: rgba(37,99,235,0.25); border-radius: 2px; }

    .vocab-translation-overlay { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
    .vocab-translation-overlay__item { position: absolute; top: 0; left: 0; transform: translate3d(0,0,0); white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; font-size: 0.42em; font-style: italic; font-weight: 400; letter-spacing: 0.015em; color: #6b6b6b; opacity: 0.85; line-height: 1; pointer-events: none; user-select: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; will-change: transform; }

    /* Progress tracking via scroll */
    html { scroll-behavior: smooth; }
  </style>
  <script>
    // Slice 8b — flag that downstream code checks to route highlights through
    // the SVG overlayer. Set before the overlayer IIFE so init can read it.
    ${overlayFlagSetter}
  </script>
  ${overlayScript ? `<script>${overlayScript}</script>` : ''}
  <script>${READER_SELECTION_BRIDGE}</script>
  <script>
    let lastProgress = 0;

    // Bounds of the chapter under the reading line, in document coordinates.
    // Infinite scroll appends chapters into THIS document, so document
    // coordinates and chapter coordinates diverge the moment chapter 2 lands.
    function currentChapterBounds() {
      if (chapterSlugs.length === 0) return null;
      var probe = window.scrollY + window.innerHeight * 0.25;
      var idx = 0;
      for (var i = chapterSlugs.length - 1; i >= 0; i--) {
        if (probe >= chapterSlugs[i].top) { idx = i; break; }
      }
      var next = chapterSlugs[idx + 1];
      return {
        slug: chapterSlugs[idx].slug,
        top: chapterSlugs[idx].top,
        bottom: next ? next.top : document.documentElement.scrollHeight
      };
    }

    function reportProgress() {
      const scrollTop = window.scrollY;
      // An EMPTY chapter has nothing to scroll and nothing to read. Because
      // __textstackRestoreScroll calls scrollTo (which fires this listener), a
      // blank chapter would otherwise bank 100% into the book-wide percent
      // without the user reading a word.
      if (document.documentElement.scrollHeight - window.innerHeight <= 0
          && (document.body.innerText || '').trim().length === 0) return;

      // Progress WITHIN THE CURRENT CHAPTER — never a fraction of the whole
      // document. RN feeds this straight into computeBookProgress() as the
      // within-chapter fraction, so a document-wide value made the book
      // percent run BACKWARDS every time infinite scroll appended a chapter
      // (two chapters loaded, standing at the end of the first, reported 0.5
      // "through chapter 1") — and the 2s debounce then persisted the lower
      // number to the server.
      var bounds = currentChapterBounds();
      var relY, progress;
      if (bounds) {
        relY = Math.max(0, scrollTop - bounds.top);
        var span = (bounds.bottom - bounds.top) - window.innerHeight;
        // A chapter shorter than the viewport is genuinely finished the moment
        // it is shown.
        progress = span > 0 ? Math.min(relY / span, 1) : 1;
      } else {
        var docHeight = document.documentElement.scrollHeight - window.innerHeight;
        relY = scrollTop;
        progress = docHeight > 0 ? Math.min(scrollTop / docHeight, 1) : 1;
      }
      if (!isFinite(progress)) return;

      if (Math.abs(progress - lastProgress) > 0.005) {
        lastProgress = progress;
        var currentSlug = bounds ? bounds.slug : getCurrentChapterSlug();
        // scrollY lets RN build a 'scroll:slug:offset' locator the way PWA
        // does (apps/web/src/hooks/useReaderScrollSync.ts). Locator wins
        // over bare percent on resume because long chapters can have
        // identical percent in many pixel positions.
        //
        // It is CHAPTER-relative for the same reason as the percent above:
        // resume loads that one chapter alone, so an absolute offset from a
        // multi-chapter document landed the reader at the wrong place (and,
        // once clamped, at the very end of a chapter they had barely begun).
        // For a freshly-loaded single chapter top === 0, so the two agree.
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'progress',
          progress: progress,
          chapterSlug: currentSlug,
          scrollY: Math.round(relY)
        }));
      }
    }
    window.addEventListener('scroll', reportProgress, { passive: true });

    // RN → WebView: jump to a saved position on chapter mount, and say when it
    // landed.
    //
    // The acknowledgement is the point. These used to be fire-and-forget, so RN
    // opened its write gate the moment it INJECTED a restore — while this side
    // was still one paint away from moving, and the load event's scrollY of 0
    // was the newest thing RN knew. Pressing back inside that window saved the
    // zero over 45% of a book. The scroll these cause does fire reportProgress,
    // but that message is indistinguishable from the reader scrolling, and is
    // suppressed outright when the delta is under 0.005 — it cannot be the
    // signal. So each restore carries an id and reports back under its own
    // message type, the way the PDF viewer acks scrollToPage(page, jumpId).
    //
    // (No backticks anywhere in here: this whole document is one template
    // literal, and one would end it.)
    /**
     * Jump, without animating.
     *
     * The document sets html { scroll-behavior: smooth }, which is right for
     * the reader's own navigation and wrong for every restore: scrollTo becomes
     * an animation, window.scrollY still reads the OLD position on the next
     * line, and the acknowledgement below therefore reported a place the reader
     * was not yet at. Meanwhile the animation kept firing reportProgress with
     * intermediate positions after the gate had already opened, so the 2s
     * debounce could persist one of them. A restore is a jump, not a journey.
     *
     * scroll-behavior is toggled on the element rather than passing
     * behavior:'instant', because that value is not understood everywhere the
     * app runs and an unknown value falls back to the CSS — i.e. to smooth.
     */
    function scrollToInstant(y) {
      var root = document.documentElement;
      var prev = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.scrollTo(0, y);
      root.style.scrollBehavior = prev;
    }

    function ackRestore(restoreId) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'restored',
        restoreId: restoreId,
        scrollY: Math.round(window.scrollY)
      }));
    }

    window.__textstackRestoreScroll = function(offsetY, restoreId) {
      try {
        var offset = Math.max(0, Math.floor(offsetY) || 0);
        // requestAnimationFrame to wait one paint so the reader's own
        // mount-time scroll-to-top doesn't race ahead and clobber us.
        requestAnimationFrame(function() {
          // The saved offset is CHAPTER-relative — reportProgress subtracts the
          // chapter's top before emitting it. This used to treat it as a
          // document coordinate, which agreed only while the first chapter's
          // recorded top was zero. It is now the real top of the element, which
          // sits below the reader's own page padding, so the two have to be
          // added back together. A fresh document holds the restored chapter
          // and nothing before it, hence index 0.
          recomputeChapterTops();
          var base = chapterSlugs.length > 0 ? chapterSlugs[0].top : 0;
          scrollToInstant(Math.max(0, base + offset));
          ackRestore(restoreId);
        });
      } catch (e) {}
    };

    // The percent branch: no saved pixel offset, only a fraction of the chapter.
    // It used to be a raw string injected from the hook with no function behind
    // it here, which is why it had nowhere to report from. Same shape, same ack.
    //
    // The fraction it is handed is CHAPTER-scoped — reportProgress divides by
    // (bounds.bottom - bounds.top) - innerHeight. This used to multiply it by
    // the whole document's scrollHeight and not subtract the viewport at all,
    // so even with one chapter loaded it landed roughly innerHeight x fraction
    // too deep, and at fraction ~1 it clamped to the very bottom. Restoring by
    // percent was never safe; it is now the exact inverse of the report.
    window.__textstackRestorePercent = function(pct, restoreId) {
      try {
        var fraction = Math.min(1, Math.max(0, Number(pct) || 0));
        requestAnimationFrame(function() {
          scrollToInstant(chapterScrollTarget(0, fraction));
          ackRestore(restoreId);
        });
      } catch (e) {}
    };

    // Document Y that puts the reading line the given fraction of the way
    // through the chapter at idx. Inverse of reportProgress. Tops are
    // recomputed first --
    // a restore always follows something that changed the layout.
    function chapterScrollTarget(idx, fraction) {
      recomputeChapterTops();
      var docBottom = document.documentElement.scrollHeight;
      var top = 0, bottom = docBottom;
      if (chapterSlugs.length > idx && idx >= 0) {
        top = chapterSlugs[idx].top;
        bottom = chapterSlugs[idx + 1] ? chapterSlugs[idx + 1].top : docBottom;
      }
      var span = (bottom - top) - window.innerHeight;
      return Math.max(0, Math.round(top + (span > 0 ? span * fraction : 0)));
    }

    /**
     * Change typography on the LIVE document and keep the reader where they were.
     *
     * Typography used to be an input to the document string, so changing a font
     * size reloaded the WebView — which threw away every chapter infinite scroll
     * had appended and then restored a chapter-two fraction into a chapter-one
     * document. Injecting the CSS instead keeps the document, so there is
     * nothing to lose and nothing to re-fetch.
     *
     * The three steps are one call because the middle one has to happen between
     * the other two: measure where the reader is BEFORE the reflow (afterwards
     * the old coordinates mean nothing), restyle, then recompute the chapter
     * tops the reflow just invalidated and put the same chapter fraction back
     * under the reading line. The scroll fires reportProgress, so it carries a
     * restoreId and acks like any other restore — the write gate is what stops
     * the transient from being saved, and it already exists.
     */
    window.__textstackApplyTypography = function(css, restoreId) {
      try {
        var before = currentChapterBounds();
        var idx = 0, fraction = 0;
        if (before) {
          for (var i = 0; i < chapterSlugs.length; i++) {
            if (chapterSlugs[i].slug === before.slug) { idx = i; break; }
          }
          var span = (before.bottom - before.top) - window.innerHeight;
          fraction = span > 0 ? Math.min(1, Math.max(0, (window.scrollY - before.top) / span)) : 0;
        }
        var style = document.getElementById('ts-typography');
        if (!style) {
          style = document.createElement('style');
          style.id = 'ts-typography';
          document.head.appendChild(style);
        }
        style.textContent = css;
        requestAnimationFrame(function() {
          scrollToInstant(chapterScrollTarget(idx, fraction));
          // Highlights and vocab underlines are drawn from Range rects, and a
          // style change fires no resize event — the overlayer's own listeners
          // never hear about this one.
          try { if (typeof _hlOverlayer !== 'undefined' && _hlOverlayer) _hlOverlayer.redraw(); } catch (e) {}
          try { if (typeof vhlScheduleReposition === 'function') vhlScheduleReposition(); } catch (e) {}
          ackRestore(restoreId);
        });
      } catch (e) {}
    };

    // Scroll to a RAG citation (AI-026d): find a short snippet of the chunk in the rendered text
    // (offsets are into PlainText, not this DOM, so we locate by text) and center it; else scroll
    // proportionally by the char offset. Mirror of the web citationScroll strategy, in-WebView.
    window.__textstackScrollToCitation = function(snippet, charStart) {
      try {
        var range = null;
        if (snippet) {
          var needle = String(snippet).toLowerCase();
          var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          var node;
          while ((node = walker.nextNode())) {
            var p = node.parentElement, skip = false;
            while (p) {
              if (p.classList && (p.classList.contains('vocab-inline-translation') || p.hasAttribute('data-vocab-overlay'))) { skip = true; break; }
              p = p.parentElement;
            }
            if (skip) continue;
            var idx = (node.nodeValue || '').toLowerCase().indexOf(needle);
            if (idx >= 0) { range = document.createRange(); range.setStart(node, idx); range.setEnd(node, idx + needle.length); break; }
          }
        }
        if (range) {
          var rect = range.getBoundingClientRect();
          var top = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
          window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
          if (window.Highlight && window.CSS && CSS.highlights) {
            try {
              CSS.highlights.set('rag-citation', new Highlight(range));
              setTimeout(function() { CSS.highlights.delete('rag-citation'); }, 2400);
            } catch (e) {}
          }
          return;
        }
        var len = (document.body.textContent || '').length || 1;
        var frac = Math.min(1, Math.max(0, (Number(charStart) || 0) / len));
        window.scrollTo({ top: Math.round(document.documentElement.scrollHeight * frac), behavior: 'smooth' });
      } catch (e) {}
    };

    // Scroll to a saved highlight (M2): the Highlights sheet resolves a reflow
    // highlight's anchor to its DOM range and centers it — WITHOUT navigating
    // the chapter, so the reader's scroll position/progress is preserved. The
    // highlight is already painted its color, so no flash is needed. Reuses the
    // same anchor→range builder as renderHighlight (hoisted, same script scope).
    window.__textstackScrollToHighlight = function(anchor) {
      try {
        var anchorObj = null;
        if (typeof anchor === 'string') {
          try { anchorObj = JSON.parse(anchor); } catch (e) { anchorObj = { exact: anchor }; }
        } else if (anchor && typeof anchor === 'object') {
          anchorObj = anchor;
        }
        if (!anchorObj) return;
        var range = hlBuildRange(anchorObj);
        if (!range) return;
        var rect = range.getBoundingClientRect();
        var top = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } catch (e) {}
    };

    window.addEventListener('load', function() {
      console.log('[diag] load event — ua:', navigator.userAgent.slice(0, 80));
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'loaded',
        scrollHeight: document.documentElement.scrollHeight
      }));
      // Emit-on-load: the scroll-gated reportProgress only fires once the
      // reader actually moves, so a chapter the user navigates INTO records
      // nothing (and ReadingProgress.MaxChapterNumber stays unset) until they
      // scroll. Post one initial progress so ReaderShell runs its full
      // book-progress + debounced-persistence path for the DESTINATION chapter
      // immediately. Guard: only on the FIRST load (no infinite-scroll appends
      // yet — chapterSlugs holds at most the initial chapter), so appends never
      // re-fire this or reset getCurrentChapterSlug to the top chapter.
      if (chapterSlugs.length <= 1) {
        var initSlug = getCurrentChapterSlug();
        if (initSlug) {
          var initScrollTop = window.scrollY;
          var initDocHeight = document.documentElement.scrollHeight - window.innerHeight;
          var initProgress = initDocHeight > 0 ? Math.min(initScrollTop / initDocHeight, 1) : 0;
          lastProgress = initProgress;
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'progress',
            progress: initProgress,
            chapterSlug: initSlug,
            scrollY: Math.round(initScrollTop)
          }));
        }
      }
      installTopsObserver();
      recomputeChapterTops();
      setTimeout(checkInfiniteScroll, 100);
    });

    // Infinite scroll
    var infiniteScrollEnabled = false;
    var loadingNext = false;
    function checkInfiniteScroll() {
      if (!infiniteScrollEnabled || loadingNext) return;
      var scrollBottom = window.scrollY + window.innerHeight;
      var docHeight = document.documentElement.scrollHeight;
      if (docHeight - scrollBottom < 400) {
        loadingNext = true;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'requestNextChapter' }));
      }
    }
    window.addEventListener('scroll', checkInfiniteScroll, { passive: true });

    // Single-object payload: U+2028/U+2029 terminate JS lines but are valid
    // in JSON strings, so HTML must round-trip via JSON.parse, not a JS literal.
    function appendChapter(payload) {
      var html = payload && payload.html;
      var title = payload && payload.title;
      var slug = payload && payload.slug;
      if (!html) { loadingNext = false; return; }
      var sep = document.createElement('div');
      sep.className = 'chapter-separator';
      sep.innerHTML = '<hr><span>' + title + '</span>';
      document.body.appendChild(sep);
      var div = document.createElement('div');
      // The chapter gets an element of its own, named. It is the scope a
      // reading position is measured in — web has had the same thing since
      // ReaderSection stamped data-chapter-id on its <article>.
      if (slug) div.setAttribute('data-chapter-slug', slug);
      div.innerHTML = html;
      document.body.appendChild(div);
      if (slug) registerChapter(slug, div);
      loadingNext = false;
      setTimeout(checkInfiniteScroll, 100);
    }
    function enableInfiniteScroll() { infiniteScrollEnabled = true; }
    function disableInfiniteScroll() { infiniteScrollEnabled = false; loadingNext = false; }

    // Chapter tracking for progress.
    //
    // Each entry keeps the ELEMENT, not just the number it happened to be at
    // when the chapter was appended. The old version sampled offsetTop once and
    // never looked again, which was invisible only because nothing reflowed a
    // live document: images and webfonts land before the first append, and
    // typography used to rebuild the whole document rather than restyle it.
    // The moment a font size is injected into a live document, every stored
    // top is a lie, currentChapterBounds() names the wrong chapter, and
    // reportProgress posts that wrong slug — the same corruption the rebuild
    // caused, by a different route. So tops are recomputed, never remembered.
    var chapterSlugs = [];
    function registerChapter(slug, el) {
      var node = el || document.body.lastElementChild;
      chapterSlugs.push({ slug: slug, el: node, top: chapterTop(node) });
    }
    // Document-absolute top of a chapter element. getBoundingClientRect rather
    // than offsetTop: offsetTop is measured from the offsetParent's padding
    // edge, and body carries the reader's own padding, so the two disagree by
    // exactly the top inset — which is the reading line's own margin of error.
    function chapterTop(el) {
      if (!el || !el.getBoundingClientRect) return 0;
      return Math.round(el.getBoundingClientRect().top + window.scrollY);
    }
    function recomputeChapterTops() {
      for (var i = 0; i < chapterSlugs.length; i++) {
        if (chapterSlugs[i].el) chapterSlugs[i].top = chapterTop(chapterSlugs[i].el);
      }
    }
    // Everything that can move a chapter's top: an image finishing, a webfont
    // swapping, typography being injected, a rotation. One observer covers all
    // of them, and rAF-coalesced so a burst costs one layout read.
    var _topsScheduled = false;
    function scheduleRecomputeTops() {
      if (_topsScheduled) return;
      _topsScheduled = true;
      requestAnimationFrame(function() { _topsScheduled = false; recomputeChapterTops(); });
    }
    // Installed from the load handler: this script runs in <head>, where
    // document.body is still null.
    function installTopsObserver() {
      if (typeof ResizeObserver === 'undefined' || !document.body) return;
      try { new ResizeObserver(scheduleRecomputeTops).observe(document.body); } catch (e) {}
    }
    function getCurrentChapterSlug() {
      if (chapterSlugs.length === 0) return null;
      var scrollTop = window.scrollY + window.innerHeight * 0.25;
      for (var i = chapterSlugs.length - 1; i >= 0; i--) {
        if (scrollTop >= chapterSlugs[i].top) return chapterSlugs[i].slug;
      }
      return chapterSlugs[0].slug;
    }

    // Highlight rendering
    var HIGHLIGHT_BG = { yellow: 'rgba(254,240,138,0.5)', green: 'rgba(187,247,208,0.5)', pink: 'rgba(251,207,232,0.5)', blue: 'rgba(191,219,254,0.5)' };

    // Locate a Range inside document.body using a stored text-anchor. Mirrors
    // web's findTextByAnchor: try prefix+exact+suffix, then exact-with-context,
    // then bare exact. Returns null if no reasonable match is found.
    // Anchor resolution is shared with web — window.__TSAnchor.findOffset comes
    // from packages/shared/src/reader/textAnchor.ts via the overlay bundle.
    //
    // This used to be a second implementation: the same context ladder with
    // integer scoring instead of Dice similarity, and with neither the
    // offset verification nor the fuzzy fallback. A highlight that survived a
    // book being re-parsed on the web quietly disappeared on the phone.
    //
    // The fallback keeps highlights working if an older build has an overlay
    // bundle without the anchor API — exact match only, which is what the
    // shared resolver tries first anyway.
    function hlFindAnchor(anchor) {
      if (!anchor || !anchor.exact) return null;
      var full = document.body.textContent || '';
      if (window.__TSAnchor && window.__TSAnchor.findOffset) {
        var at = window.__TSAnchor.findOffset(full, anchor);
        return at === null || at === undefined ? null : { start: at, length: anchor.exact.length };
      }
      var idx = full.indexOf(anchor.exact);
      return idx === -1 ? null : { start: idx, length: anchor.exact.length };
    }

    // Convert a global offset into document.body's textContent to a
    // (textNode, offset) pair by walking text nodes cumulatively.
    function hlLocateNode(globalOffset) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var consumed = 0;
      var node;
      while (node = walker.nextNode()) {
        var len = node.nodeValue ? node.nodeValue.length : 0;
        if (consumed + len >= globalOffset) {
          return { node: node, offset: globalOffset - consumed };
        }
        consumed += len;
      }
      return null;
    }

    // Build a Range spanning the requested text, even if it crosses multiple
    // text nodes (selection across <strong>, <em>, vocab <mark>, etc).
    function hlBuildRange(anchor) {
      var loc = hlFindAnchor(anchor);
      if (!loc) return null;
      var start = hlLocateNode(loc.start);
      var end = hlLocateNode(loc.start + loc.length);
      if (!start || !end) return null;
      var range = document.createRange();
      try {
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
      } catch (e) { return null; }
      return range;
    }

    // Slice 8b — SVG overlayer dispatcher for highlights. Vocab underlines
    // stay on CSS.highlights (text-decoration is glyph-aware, beats SVG rects).
    // Flag-gated via window.__textstackOverlayV2Mobile (set by buildReaderHtml
    // options.overlayV2). Legacy <mark> path is the default fallback.
    function hlOverlayEnabled() {
      return !!(window.__textstackOverlayV2Mobile && window.__TSOverlayer && typeof window.__TSOverlayer.create === 'function');
    }
    function hlEnsureOverlayer() {
      if (_hlOverlayer) return _hlOverlayer;
      if (!hlOverlayEnabled()) return null;
      try {
        _hlOverlayer = window.__TSOverlayer.create();
        _hlOverlayer.element.style.zIndex = '2';
        document.body.appendChild(_hlOverlayer.element);
        // Reflow on font load, resize, orientation change — overlayer draws
        // from range rects, which must be re-computed whenever layout shifts.
        window.addEventListener('resize', function(){ try { _hlOverlayer.redraw(); } catch(e) {} });
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
          document.fonts.ready.then(function(){ try { _hlOverlayer.redraw(); } catch(e) {} });
        }
        // Image-load reflow (foliate paginator.js pattern). Images in chapter
        // intros / PDF illustrations load after first paint → text flows down
        // → overlay rects stale until scroll. Listen on each img.load; one rAF
        // redraw per burst.
        var _imgRedrawScheduled = false;
        function scheduleImgRedraw() {
          if (_imgRedrawScheduled || !_hlOverlayer) return;
          _imgRedrawScheduled = true;
          requestAnimationFrame(function() {
            _imgRedrawScheduled = false;
            try { _hlOverlayer.redraw(); } catch(e) {}
          });
        }
        function watchImage(img) {
          if (!img || img.__tsReflowWatched) return;
          img.__tsReflowWatched = true;
          if (img.complete && img.naturalWidth > 0) return;
          img.addEventListener('load', scheduleImgRedraw, { once: true });
          img.addEventListener('error', scheduleImgRedraw, { once: true });
        }
        var imgs = document.getElementsByTagName('img');
        for (var ii = 0; ii < imgs.length; ii++) watchImage(imgs[ii]);
        try {
          var _imgObserver = new MutationObserver(function(muts) {
            for (var mi = 0; mi < muts.length; mi++) {
              var added = muts[mi].addedNodes;
              for (var ni = 0; ni < added.length; ni++) {
                var n = added[ni];
                if (n.nodeType !== 1) continue;
                if (n.tagName === 'IMG') watchImage(n);
                else if (n.getElementsByTagName) {
                  var nested = n.getElementsByTagName('img');
                  for (var xi = 0; xi < nested.length; xi++) watchImage(nested[xi]);
                }
              }
            }
          });
          _imgObserver.observe(document.body, { childList: true, subtree: true });
        } catch (e) { /* no MutationObserver */ }
        // Doc-coord rects + CSS counter-translate on scroll → no full redraw
        // per scroll frame, just an O(1) transform update.
        var _scrollScheduled = false;
        window.addEventListener('scroll', function(){
          if (_scrollScheduled || !_hlOverlayer) return;
          _scrollScheduled = true;
          requestAnimationFrame(function(){
            _scrollScheduled = false;
            try { _hlOverlayer.syncScroll(); } catch(e) {}
          });
        }, { passive: true });
        // Tap delegation — overlayer is pointer-events:none so taps hit body.
        // hitTest returns [key, range] when a rect covers the point.
        document.body.addEventListener('click', function(e){
          if (!_hlOverlayer) return;
          // iOS WebKit fires a synthetic click ~300 ms after touchend; skip
          // the replay so a single tap doesn't post highlightTap twice.
          if (_hlOverlayer.isJustAnchored && _hlOverlayer.isJustAnchored()) return;
          var hit = _hlOverlayer.hitTest({ x: e.clientX, y: e.clientY });
          if (!hit || !hit.length || !hit[0]) return;
          var key = hit[0];
          if (key.indexOf('user-hl:') !== 0) return;
          var id = key.slice('user-hl:'.length);
          if (_hlOverlayer.markJustAnchored) _hlOverlayer.markJustAnchored();
          try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'highlightTap', highlightId: id })); } catch (err) {}
        }, true);
      } catch (e) {
        console.warn('[diag] hlEnsureOverlayer failed:', e && e.message);
        _hlOverlayer = null;
      }
      return _hlOverlayer;
    }
    function hlPaintRangeOverlay(range, id, color) {
      var ov = hlEnsureOverlayer();
      if (!ov) return { ok: false, painted: 0, total: 0 };
      var bg = HIGHLIGHT_BG[color] || HIGHLIGHT_BG.yellow;
      try {
        ov.add('user-hl:' + id, range, window.__TSOverlayer.highlight, { color: bg, opacity: 1, blendMode: 'multiply' });
        return { ok: true, painted: 1, total: 1 };
      } catch (e) {
        console.warn('[diag] hlPaintRangeOverlay failed:', id, e && e.message);
        return { ok: false, painted: 0, total: 0 };
      }
    }
    function hlRemoveOverlay(id) {
      if (!_hlOverlayer) return false;
      try { _hlOverlayer.remove('user-hl:' + id); return true; } catch (e) { return false; }
    }

    // Paint a highlight by wrapping each text node the range intersects in
    // its own <mark>. Handles multi-node ranges that surroundContents can't.
    // Returns { ok, painted, total } so the caller can see partial paints.
    function hlPaintRange(range, id, color) {
      var bg = HIGHLIGHT_BG[color] || HIGHLIGHT_BG.yellow;
      var walker = document.createTreeWalker(
        range.commonAncestorContainer,
        NodeFilter.SHOW_TEXT,
        { acceptNode: function(n) { return range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } }
      );
      var targets = [];
      var n;
      while (n = walker.nextNode()) targets.push(n);
      if (targets.length === 0 && range.commonAncestorContainer.nodeType === 3) {
        targets.push(range.commonAncestorContainer);
      }
      if (targets.length === 0) return { ok: false, painted: 0, total: 0 };
      var painted = 0, attempted = 0;
      for (var i = 0; i < targets.length; i++) {
        var tn = targets[i];
        var startOff = (tn === range.startContainer) ? range.startOffset : 0;
        var endOff = (tn === range.endContainer) ? range.endOffset : (tn.nodeValue ? tn.nodeValue.length : 0);
        if (endOff <= startOff) continue;
        attempted++;
        var subRange = document.createRange();
        try { subRange.setStart(tn, startOff); subRange.setEnd(tn, endOff); } catch (e) { continue; }
        var mark = document.createElement('mark');
        mark.dataset.highlightId = id;
        mark.style.backgroundColor = bg;
        mark.style.borderRadius = '2px';
        mark.style.cursor = 'pointer';
        mark.addEventListener('click', function(e) {
          e.stopPropagation();
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'highlightTap', highlightId: id }));
        });
        try { subRange.surroundContents(mark); painted++; } catch (e) { /* skip, report at caller */ }
      }
      return { ok: painted > 0, painted: painted, total: attempted };
    }

    // Public entry. Accepts either an anchor object/JSON (preferred) or a
    // bare selectedText string for back-compat. Idempotent: wipes prior
    // segments for this id before repainting.
    function renderHighlight(id, anchor, color, fallbackText) {
      if (!color) { console.warn('[diag] renderHighlight: missing color', id); return; }
      var snippet = '';
      try {
        // Drop stale segments so re-renders (chapter reload) don't double-paint.
        var existing = document.querySelectorAll('mark[data-highlight-id="' + CSS.escape(id) + '"]');
        if (existing.length) {
          existing.forEach(function(m) {
            var p = m.parentNode;
            while (m.firstChild) p.insertBefore(m.firstChild, m);
            p.removeChild(m);
            if (p.normalize) p.normalize();
          });
        }
      } catch (e) {}
      var anchorObj = null;
      if (typeof anchor === 'string') {
        try { anchorObj = JSON.parse(anchor); } catch (e) { anchorObj = { exact: anchor }; }
      } else if (anchor && typeof anchor === 'object') {
        anchorObj = anchor;
      }
      if (!anchorObj || !anchorObj.exact) {
        if (fallbackText) anchorObj = { exact: fallbackText };
      }
      if (!anchorObj || !anchorObj.exact) { console.warn('[diag] renderHighlight: no anchor', id); return; }
      snippet = anchorObj.exact.length > 30 ? anchorObj.exact.slice(0, 30) + '…' : anchorObj.exact;
      var range = hlBuildRange(anchorObj);
      if (!range) { console.warn('[diag] renderHighlight NO MATCH:', id, snippet); return; }
      // Dispatcher: overlay path if flag on + overlayer available, else legacy <mark>.
      var res = hlOverlayEnabled() ? hlPaintRangeOverlay(range, id, color) : hlPaintRange(range, id, color);
      if (!res.ok) console.warn('[diag] renderHighlight paint failed:', id, snippet);
      else if (res.painted < res.total) console.warn('[diag] renderHighlight partial:', id, snippet, res.painted + '/' + res.total);
      else console.log('[diag] renderHighlight matched:', id, snippet);
    }

    function removeHighlight(id) {
      // Overlay path is additive — legacy <mark> cleanup still runs in case
      // a stale DOM mark exists (e.g. during flag flip mid-session).
      hlRemoveOverlay(id);
      var marks = document.querySelectorAll('mark[data-highlight-id="' + id + '"]');
      marks.forEach(function(mark) {
        var parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      });
    }

    // =========================================================
    // Vocab highlight layer — mirrors web's dispatcher design.
    //
    //   new path: CSS.highlights (Range-based, no DOM mutation → survives
    //             chapter innerHTML appends, font changes, resize).
    //   legacy path: <mark data-vocab-mark> wrapper (pre-refactor).
    //
    // Dispatcher per call: feature-detect + runtime killswitch. Exterior API
    // unchanged (markVocabWords / addVocabWord / removeVocabMarks /
    // setShowInlineTranslations) so mobile reader pages need no edits.
    // =========================================================

    var VOCAB_STAGE_COLORS = {
      0: 'rgba(59,130,246,0.5)',   // new — blue
      1: 'rgba(234,179,8,0.5)',    // recognition — yellow
      2: 'rgba(234,179,8,0.4)',    // recall
      3: 'rgba(34,197,94,0.4)',    // context — green
      4: 'rgba(34,197,94,0.25)'    // mastered — faint green
    };
    var VOCAB_ATTR = 'data-vocab-mark';
    var VHL_STAGE_NAMES = { 0: 'vocab-new', 1: 'vocab-recognition', 2: 'vocab-recall', 3: 'vocab-context', 4: 'vocab-mastered' };
    var VHL_MANAGED_NAMES = ['vocab-new','vocab-recognition','vocab-recall','vocab-context','vocab-mastered','vocab-active'];
    var VHL_WORD_RE = /[\\p{L}\\p{N}'-]+/gu;

    // Default ON to match the React default (useReaderSettings.showInlineTranslations: true).
    // Initialising false caused a race: markVocabWords (vocab paint) often ran before the
    // setShowInlineTranslations(true) injection landed, so vhlRenderOverlay bailed and the
    // gloss never drew on first load — only a settings toggle forced a re-paint. Starting
    // true makes the gloss draw from the first paint; the off-injection still hides it for
    // users who disabled it.
    var _showInlineTranslations = true;
    var _currentVocabMap = {};
    var _vhlSupport = null;

    function vhlIsSupported() {
      if (_vhlSupport !== null) return _vhlSupport;
      try {
        _vhlSupport = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
        // Smoke: construct and register+delete a Highlight.
        if (_vhlSupport) { var h = new Highlight(); CSS.highlights.set('__vhl_probe__', h); CSS.highlights.delete('__vhl_probe__'); }
      } catch (e) { _vhlSupport = false; }
      return _vhlSupport;
    }
    function vhlKillswitchSet() {
      try { return !!window.__textstackDisableCustomHighlights; } catch (e) { return false; }
    }
    function vhlUseNew() { return vhlIsSupported() && !vhlKillswitchSet(); }

    // Word-boundary check using a unicode letter/number class.
    var VHL_WORDCHAR_RE = /[\\p{L}\\p{N}]/u;

    // Pure: TreeWalker → Range objects. No DOM mutation. Rejects SCRIPT/STYLE
    // and the translation overlay subtree (data-vocab-overlay). Matches both
    // single-word and multi-word phrase keys (longest-first to avoid overlap).
    function vhlCompute(vocabMap) {
      var out = [];
      if (!vocabMap) return out;

      // Split keys by whitespace presence: single tokens hit the regex pass,
      // phrases hit the substring-scan pass first (longest first).
      var singleKeys = {};
      var phraseKeys = [];
      for (var k in vocabMap) {
        if (!Object.prototype.hasOwnProperty.call(vocabMap, k)) continue;
        var lk = k.toLowerCase();
        if (lk.indexOf(' ') === -1) singleKeys[lk] = vocabMap[k];
        else phraseKeys.push({ key: lk, entry: vocabMap[k] });
      }
      phraseKeys.sort(function(a, b) { return b.key.length - a.key.length; });

      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest('[data-vocab-overlay]')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var node;
      while (node = walker.nextNode()) {
        var text = node.textContent;
        if (!text || !text.trim()) continue;
        var lower = text.toLowerCase();
        var occupied = phraseKeys.length > 0 ? new Uint8Array(text.length) : null;

        // Phrase pass — longest first; word-boundary on both ends; skip
        // if the span overlaps an already-claimed phrase region.
        for (var p = 0; p < phraseKeys.length; p++) {
          var phr = phraseKeys[p];
          var search = 0;
          while (true) {
            var idx = lower.indexOf(phr.key, search);
            if (idx === -1) break;
            var endIdx = idx + phr.key.length;
            var beforeOk = idx === 0 || !VHL_WORDCHAR_RE.test(text.charAt(idx - 1));
            var afterOk = endIdx >= text.length || !VHL_WORDCHAR_RE.test(text.charAt(endIdx));
            if (beforeOk && afterOk) {
              var collide = false;
              for (var oi = idx; oi < endIdx; oi++) {
                if (occupied[oi]) { collide = true; break; }
              }
              if (!collide) {
                try {
                  var rng = document.createRange();
                  rng.setStart(node, idx);
                  rng.setEnd(node, endIdx);
                  out.push({ range: rng, stage: phr.entry.stage, key: phr.key, translation: phr.entry.translation || null });
                  for (var oj = idx; oj < endIdx; oj++) occupied[oj] = 1;
                } catch (e) {}
              }
            }
            search = idx + 1;
          }
        }

        // Single-word pass — skip indices already claimed by a phrase match.
        VHL_WORD_RE.lastIndex = 0;
        var m;
        while (m = VHL_WORD_RE.exec(text)) {
          if (occupied && occupied[m.index]) continue;
          var sLower = m[0].toLowerCase();
          var sEntry = singleKeys[sLower];
          if (!sEntry) continue;
          var range = document.createRange();
          try { range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length); }
          catch (e) { continue; }
          out.push({ range: range, stage: sEntry.stage, key: sLower, translation: sEntry.translation || null });
        }
      }
      return out;
    }

    function vhlSync(matches) {
      if (!vhlIsSupported()) return;
      var groups = {};
      for (var i = 0; i < matches.length; i++) {
        var mm = matches[i];
        var name = VHL_STAGE_NAMES[mm.stage] || VHL_STAGE_NAMES[0];
        if (!groups[name]) groups[name] = [];
        groups[name].push(mm.range);
      }
      for (var n = 0; n < VHL_MANAGED_NAMES.length; n++) {
        var nm = VHL_MANAGED_NAMES[n];
        var ranges = groups[nm] || [];
        if (ranges.length === 0) { try { CSS.highlights.delete(nm); } catch (e) {} continue; }
        try {
          var hl = new Highlight();
          for (var k = 0; k < ranges.length; k++) hl.add(ranges[k]);
          CSS.highlights.set(nm, hl);
        } catch (e) { console.warn('[vhl] sync error', nm, e && e.message); }
      }
    }

    function vhlClear() {
      if (!vhlIsSupported()) return;
      for (var i = 0; i < VHL_MANAGED_NAMES.length; i++) {
        try { CSS.highlights.delete(VHL_MANAGED_NAMES[i]); } catch (e) {}
      }
    }

    // Translation overlay — absolute-positioned spans, one per translatable
    // match. Positions update via RAF on scroll/resize.
    var _vhlOverlayEl = null;
    var _vhlOverlayItems = [];
    var _vhlOverlayRaf = 0;

    function vhlEnsureOverlay() {
      if (_vhlOverlayEl && document.body.contains(_vhlOverlayEl)) return _vhlOverlayEl;
      _vhlOverlayEl = document.createElement('div');
      _vhlOverlayEl.className = 'vocab-translation-overlay';
      _vhlOverlayEl.setAttribute('data-vocab-overlay', 'true');
      document.body.appendChild(_vhlOverlayEl);
      return _vhlOverlayEl;
    }
    function vhlClearOverlay() {
      if (_vhlOverlayEl) _vhlOverlayEl.innerHTML = '';
      _vhlOverlayItems = [];
    }
    function vhlRenderOverlay(matches) {
      vhlClearOverlay();
      if (!_showInlineTranslations) return;
      var overlay = vhlEnsureOverlay();
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        if (!m.translation) continue;
        var span = document.createElement('span');
        span.className = 'vocab-translation-overlay__item';
        span.textContent = m.translation;
        overlay.appendChild(span);
        _vhlOverlayItems.push({ range: m.range, el: span });
      }
      vhlRepositionOverlay();
    }
    function vhlRepositionOverlay() {
      for (var i = 0; i < _vhlOverlayItems.length; i++) {
        var item = _vhlOverlayItems[i];
        var rect;
        try { rect = item.range.getBoundingClientRect(); } catch (e) { item.el.style.display = 'none'; continue; }
        if (!rect || !rect.width || !rect.height) { item.el.style.display = 'none'; continue; }
        item.el.style.display = '';
        var cx = Math.round(rect.left + rect.width / 2 + window.scrollX);
        var topY = Math.round(rect.top + window.scrollY - 2);
        item.el.style.transform = 'translate3d(' + cx + 'px,' + topY + 'px,0) translate(-50%,-100%)';
      }
    }
    function vhlScheduleReposition() {
      if (_vhlOverlayRaf) return;
      _vhlOverlayRaf = requestAnimationFrame(function() {
        _vhlOverlayRaf = 0;
        vhlRepositionOverlay();
      });
    }
    window.addEventListener('scroll', vhlScheduleReposition, { passive: true, capture: true });
    window.addEventListener('resize', vhlScheduleReposition);

    // Legacy <mark> path — preserved as fallback.
    function vhlLegacyMark(vocabMap) {
      vhlLegacyRemove();
      if (!vocabMap || Object.keys(vocabMap).length === 0) return;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.tagName === 'MARK' || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var textNodes = [];
      var node;
      while (node = walker.nextNode()) textNodes.push(node);
      var re = /[\\p{L}\\p{N}'-]+/gu;
      for (var i = 0; i < textNodes.length; i++) {
        var tn = textNodes[i];
        var text = tn.textContent;
        if (!text || !text.trim()) continue;
        re.lastIndex = 0;
        var match;
        var matches = [];
        while (match = re.exec(text)) {
          var lower = match[0].toLowerCase();
          if (vocabMap[lower]) matches.push({ start: match.index, end: match.index + match[0].length, word: lower });
        }
        if (matches.length === 0) continue;
        var frag = document.createDocumentFragment();
        var lastEnd = 0;
        for (var j = 0; j < matches.length; j++) {
          var mm = matches[j];
          if (mm.start > lastEnd) frag.appendChild(document.createTextNode(text.slice(lastEnd, mm.start)));
          var mk = document.createElement('mark');
          mk.setAttribute(VOCAB_ATTR, 'true');
          var entry = vocabMap[mm.word];
          var stage = entry.stage;
          mk.style.cssText = 'background:none;color:inherit;padding:0;position:relative;border-bottom:2px solid ' + (VOCAB_STAGE_COLORS[stage] || VOCAB_STAGE_COLORS[0]) + ';';
          mk.textContent = text.slice(mm.start, mm.end);
          if (_showInlineTranslations && entry.translation) {
            var sp = document.createElement('span');
            sp.className = 'vocab-inline-translation';
            sp.style.cssText = 'position:absolute;left:50%;bottom:calc(100% - 4px);transform:translateX(-50%);white-space:nowrap;font-size:0.5em;font-style:italic;opacity:0.4;line-height:1;pointer-events:none;user-select:none;max-width:150%;overflow:hidden;text-overflow:ellipsis;';
            sp.textContent = entry.translation;
            mk.appendChild(sp);
          }
          frag.appendChild(mk);
          lastEnd = mm.end;
        }
        if (lastEnd < text.length) frag.appendChild(document.createTextNode(text.slice(lastEnd)));
        tn.parentNode.replaceChild(frag, tn);
      }
    }
    function vhlLegacyRemove() {
      var marks = document.querySelectorAll('mark[' + VOCAB_ATTR + ']');
      marks.forEach(function(mark) {
        var parent = mark.parentNode;
        if (!parent) return;
        var wordText = mark.firstChild && mark.firstChild.nodeType === 3 ? mark.firstChild.textContent : mark.textContent;
        parent.replaceChild(document.createTextNode(wordText || ''), mark);
        parent.normalize();
      });
    }

    // Re-apply vocab marks after DOM mutations (e.g. appendChapter replaces a
    // chunk of body). RAF-debounced, only runs if a vocab map is loaded.
    var _vhlMutRaf = 0;
    var _vhlMutObserver = null;
    var _vhlMutAttached = false;
    // Pause the observer across our own DOM writes. Without this, every
    // legacy-mark wrap / unwrap and every overlay span append re-triggers
    // markVocabWords → infinite RAF-bounded loop.
    function vhlPauseObserver() {
      if (_vhlMutObserver && _vhlMutAttached) {
        try { _vhlMutObserver.disconnect(); } catch (e) {}
        _vhlMutAttached = false;
      }
    }
    function vhlResumeObserver() {
      if (_vhlMutObserver && !_vhlMutAttached) {
        try {
          _vhlMutObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
          _vhlMutAttached = true;
          // Drop anything the observer buffered before the reconnect —
          // those were our own writes.
          if (_vhlMutObserver.takeRecords) { try { _vhlMutObserver.takeRecords(); } catch (e) {} }
        } catch (e) {}
      }
    }
    function vhlEnsureObserver() {
      if (_vhlMutObserver) return;
      try {
        _vhlMutObserver = new MutationObserver(function() {
          if (_vhlMutRaf) return;
          _vhlMutRaf = requestAnimationFrame(function() {
            _vhlMutRaf = 0;
            if (!_currentVocabMap || Object.keys(_currentVocabMap).length === 0) return;
            try { markVocabWords(_currentVocabMap); } catch (e) { console.warn('[vhl] mutation apply failed', e && e.message); }
          });
        });
        _vhlMutObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        _vhlMutAttached = true;
      } catch (e) { console.warn('[vhl] observer attach failed', e && e.message); }
    }
    window.addEventListener('load', vhlEnsureObserver);

    // Public API — unchanged signatures for all mobile call sites.
    function setShowInlineTranslations(val) {
      _showInlineTranslations = !!val;
      if (Object.keys(_currentVocabMap).length > 0) markVocabWords(_currentVocabMap);
    }

    function markVocabWords(vocabMap) {
      _currentVocabMap = vocabMap || {};
      // Observer watches body. Every wrap/unwrap/overlay-append we do here
      // would re-fire it → markVocabWords → loop. Pause while we write,
      // resume after (finally: always restores even on throw).
      vhlPauseObserver();
      try {
        vhlLegacyRemove();
        vhlClear();
        vhlClearOverlay();
        if (!vocabMap || Object.keys(vocabMap).length === 0) return;
        if (vhlUseNew()) {
          try {
            var matches = vhlCompute(vocabMap);
            vhlSync(matches);
            vhlRenderOverlay(matches);
            return;
          } catch (e) {
            console.warn('[vhl] new path failed → legacy', e && e.message);
            vhlClear();
            vhlClearOverlay();
          }
        }
        vhlLegacyMark(vocabMap);
      } finally {
        vhlResumeObserver();
      }
    }

    function addVocabWord(word, stage) {
      var key = word.toLowerCase();
      var existing = _currentVocabMap[key] || {};
      existing.stage = stage;
      _currentVocabMap[key] = existing;
      markVocabWords(_currentVocabMap);
    }

    function removeVocabMarks() {
      vhlPauseObserver();
      try {
        vhlLegacyRemove();
        vhlClear();
        vhlClearOverlay();
      } finally {
        vhlResumeObserver();
      }
    }

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

      function isLightboxImg(t) {
        return t && t.tagName === 'IMG' && !t.closest('.ts-img-lightbox');
      }

      // Delegated on document, NOT on document.body.
      //
      // Every script in this file is emitted inside <head>, and this IIFE runs
      // as the parser reaches it — before <body> exists. document.body is null
      // at that moment, so the old line threw "Cannot read properties of null
      // (reading 'addEventListener')" on every single reader load. It was the
      // last statement in the IIFE, so nothing downstream broke visibly: the
      // lightbox simply never got a listener, and tapping an image did nothing,
      // on every book with images.
      //
      // click bubbles to document, so delegation there is equivalent — and
      // document exists while <head> is parsed, which body does not.
      // Use click (after touchend), iOS WebKit fires it ~300ms after.
      document.addEventListener('click', function(e) {
        var t = e.target;
        if (!isLightboxImg(t)) return;
        // Don't open if image is inside an overlay layer (defensive).
        if (t.closest('[data-vocab-overlay]') || t.closest('[data-reader-overlay]')) return;
        // If wrapped in <a>, prevent navigation in favor of lightbox.
        var a = t.closest('a');
        if (a) e.preventDefault();
        open(t.currentSrc || t.src, t.alt || '');
      });
    })();
  </script>
</head>
<body>
  <div${initialChapterSlug ? ` data-chapter-slug="${escapeAttr(initialChapterSlug)}"` : ''}>${chapterHtml}</div>
  ${initialChapterSlug ? `<script>registerChapter(${JSON.stringify(initialChapterSlug)}, document.querySelector('[data-chapter-slug]'));</script>` : ''}
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
 * Full HTML document for the Original-layout PDF viewer (ADR-012 S4b). Parallel
 * to `buildReaderHtml` — it emits the SAME shared selection bridge so the DOM→native
 * selection/tap/scroll-direction path is identical over the pdf.js text layer, then
 * the bundled pdf.js viewer controller, bootstrapped with the file URL + Bearer token.
 *
 * Auth: the token is handed to pdf.js via `httpHeaders` INSIDE the controller (not
 * embedded in the URL) — the WebView must be mounted with `baseUrl` set to the API
 * origin so the lazy Range requests are same-origin (no CORS preflight). Persistent
 * highlight CREATE + PAINT over the PDF text layer are live (ADR "PDF highlights"
 * S-c) via the bundled viewer's `__setPdfHighlights` / `__pdfCreateHighlight`;
 * vocab underline PAINTING over the PDF text layer is still deferred. Selection
 * ACTIONS (translate / explain / vocab / TTS) run via the shared bridge.
 */
export function buildPdfViewerHtml(fileUrl: string, token: string | null, options: PdfViewerHtmlOptions = {}): string {
  const theme = options.theme ?? defaultTheme
  const initialPage = options.initialPage ?? null
  // Chrome (safe-area padding + theme colours) is emitted from the same values
  // that `pdfChromeInjectionJs` later applies to the LIVE document, so a bar
  // toggle or a theme switch no longer has to rebuild this string. Rebuilding it
  // reloads the WebView, and a reloaded pdf.js reopens at page 1 — see
  // `pdfViewerChrome.ts` for the 17-pages-lost incident behind this.
  const chrome: PdfChrome = {
    safeArea: { top: options.safeArea?.top ?? 0, bottom: options.safeArea?.bottom ?? 0 },
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  }
  const bootstrap = JSON.stringify({ url: fileUrl, token, initialPage })

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <!-- Pinch-zoom is ENABLED here and nowhere else. A PDF is a fixed layout: on a
       portrait phone an A4 page fits to width at roughly 6pt, and the app is
       locked to portrait, so without zoom a scanned or dense PDF is unreadable.
       The reflow document above keeps user-scalable=no on purpose — there the
       font-size control is the zoom, and page scaling would desynchronise the
       highlight overlay's coordinate math. -->
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: none; }
    body {
      -webkit-user-select: text;
      user-select: text;
      -webkit-touch-callout: default;
    }
    ${pdfChromeCss(chrome)}
    .pdf-pages { display: flex; flex-direction: column; align-items: center; }
    .pdf-page {
      position: relative;
      margin: 6px auto;
      background: #ffffff;
      box-shadow: 0 1px 5px rgba(0,0,0,0.25);
      overflow: hidden;
    }
    .pdf-page__canvas { display: block; }
    .pdf-page__placeholder {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%;
      color: #b0b0b0;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 14px;
    }
    /* pdf.js text layer — transparent selectable spans laid over the canvas. */
    .textLayer {
      position: absolute; left: 0; top: 0; right: 0; bottom: 0;
      overflow: hidden;
      line-height: 1;
      text-align: initial;
      opacity: 1;
      forced-color-adjust: none;
      -webkit-text-size-adjust: none; text-size-adjust: none;
      transform-origin: 0 0;
      z-index: 1;
    }
    .textLayer span, .textLayer br {
      color: transparent;
      position: absolute;
      white-space: pre;
      cursor: text;
      transform-origin: 0% 0%;
    }
    ::selection { background: rgba(37,99,235,0.3); }

    /* Persistent PDF highlights (ADR "PDF highlights" S-c) — one layer per
     * rendered page over the text layer. Both the layer AND the tinted rects
     * are click-through (pointer-events:none) so a long-press/drag STARTING
     * over an existing highlight still hits the text layer beneath and can
     * (re)select — M2 mobile parity. Tap-to-edit is restored via a geometric
     * hit-test (__pdfHighlightAtPoint) instead of the rect's own click handler.
     * z-index 2 sits above the text layer (z1). Multiply gives the marker feel
     * on the white scan while keeping glyphs legible. Mirror of web
     * pdfOriginal.css .pdf-hl-* (post-M2). */
    .pdf-hl-layer { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
    .pdf-hl-rect {
      position: absolute;
      pointer-events: none;
      border-radius: 2px;
      mix-blend-mode: multiply;
    }

    /* Tap pulse animation — reused by the shared bridge's word-tap feedback. */
    /* Same persistent mark as the reflow reader — the PDF text layer shares the
       selection bridge, so it shared the vanishing-highlight problem too. */
    .ts-word-mark { background-color: rgba(196,112,75,0.35); border-radius: 2px; }
  </style>
  <script>window.__TS_PDF = ${bootstrap};</script>
  <script>${READER_SELECTION_BRIDGE}</script>
  <script>${PDF_VIEWER_SCRIPT}</script>
</head>
<body>
  <div id="pdf-root"></div>
</body>
</html>`
}
