import { openDyslexicBase64 } from './openDyslexicBase64'
import { pdfChromeCss } from './pdfViewerChrome'
import { readerChromeCss, type ReaderChrome } from './readerChrome'
import { READER_OVERLAY_SCRIPT } from './readerOverlayScript'
import { READER_ANCHOR_SCRIPT } from './readerAnchorScript.generated'
import { TEXT_POSITION_VERSION, POSITION_QUOTE_LENGTH, ANCHOR_CONTEXT_LENGTH } from '@textstack/shared'
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

export function buildReaderHtml(chapterHtml: string, theme: ReaderTheme = defaultTheme, initialChapterSlug?: string, safeArea?: { top: number; bottom: number }): string {
  const fontFace = buildFontFace(theme.fontFamily)
  // Chrome comes from the same values `readerChromeInjectionJs` later applies to
  // the LIVE document, so hiding the bars or switching theme no longer has to
  // rebuild this string — a rebuild reloads the WebView and re-runs the
  // position restore. See readerChrome.ts.
  const chrome: ReaderChrome = {
    safeArea: { top: safeArea?.top ?? 0, bottom: safeArea?.bottom ?? 0 },
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  }
  // The reading position is resolved from a text anchor on every chapter open
  // and has no legacy path behind it; without the resolver `hlFindAnchor`
  // degrades to a bare indexOf. 3.6KB.
  const anchorScript = READER_ANCHOR_SCRIPT

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

    .vocab-translation-overlay { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
    .vocab-translation-overlay__item { position: absolute; top: 0; left: 0; transform: translate3d(0,0,0); white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; font-size: 0.42em; font-style: italic; font-weight: 400; letter-spacing: 0.015em; color: #6b6b6b; opacity: 0.85; line-height: 1; pointer-events: none; user-select: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; will-change: transform; }

    /* Progress tracking via scroll */
    html { scroll-behavior: smooth; }
  </style>
  <script>${anchorScript}</script>
  <script>${READER_OVERLAY_SCRIPT}</script>
  <script>${READER_SELECTION_BRIDGE}</script>
  <script>
    let lastProgress = 0;

    // Bounds of the document's one chapter, in document coordinates — measured
    // fresh, never remembered (a reflow, an image or a webfont moves them).
    // The bottom is the chapter element's, not the document's: the
    // end-of-chapter block sits below it and is not part of what was read.
    function currentChapterBounds() {
      if (!tsChapter || !tsChapter.el) return null;
      var r = tsChapter.el.getBoundingClientRect();
      return {
        slug: tsChapter.slug,
        top: Math.round(r.top + window.scrollY),
        bottom: Math.round(r.bottom + window.scrollY)
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

      // Progress WITHIN THE CHAPTER — measured against the chapter element, not
      // the whole document, which also holds the end-of-chapter block. RN feeds
      // this straight into computeBookProgress() as the within-chapter fraction.
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
        var currentSlug = bounds ? bounds.slug : null;
        // scrollY lets RN build a 'scroll:slug:offset' locator the way PWA
        // does (apps/web/src/hooks/useReaderScrollSync.ts). Locator wins
        // over bare percent on resume because long chapters can have
        // identical percent in many pixel positions.
        //
        // It is CHAPTER-relative (measured from the chapter element's top,
        // below the page padding), and the restore adds that top back.
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'progress',
          progress: progress,
          chapterSlug: currentSlug,
          scrollY: Math.round(relY),
          // The logical position rides along, so RN always holds a fresh one
          // without a round trip. saveProgress is synchronous — it is called
          // from an unmount and from an AppState listener — and cannot wait for
          // an answer. Null when the reading line lands somewhere with no text.
          position: window.__textstackCapturePosition ? window.__textstackCapturePosition() : null
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
      // CHAPTER-relative, like a progress report's scrollY — RN takes it as
      // the "moved since?" baseline.
      var b = currentChapterBounds();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'restored',
        restoreId: restoreId,
        scrollY: Math.round(Math.max(0, window.scrollY - (b ? b.top : 0)))
      }));
      // The landing is always reported, AFTER the ack. A restore that moved
      // less than the report threshold used to post nothing, so the reader's
      // next real scroll was booked as the restore's jump (R4).
      lastProgress = -1;
      reportProgress();
    }

    window.__textstackRestoreScroll = function(offsetY, restoreId) {
      try {
        var offset = Math.max(0, Math.floor(offsetY) || 0);
        // requestAnimationFrame to wait one paint so the reader's own
        // mount-time scroll-to-top doesn't race ahead and clobber us.
        requestAnimationFrame(function() {
          // The saved offset is CHAPTER-relative — reportProgress subtracts the
          // chapter's top before emitting it. That top sits below the reader's
          // own page padding, so the two have to be added back together.
          var b = currentChapterBounds();
          var base = b ? b.top : 0;
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
          scrollToInstant(chapterScrollTarget(fraction));
          ackRestore(restoreId);
        });
      } catch (e) {}
    };

    // Document Y that puts the reading line the given fraction of the way
    // through the chapter. Inverse of reportProgress.
    function chapterScrollTarget(fraction) {
      var b = currentChapterBounds();
      var top = b ? b.top : 0;
      var bottom = b ? b.bottom : document.documentElement.scrollHeight;
      var span = (bottom - top) - window.innerHeight;
      return Math.max(0, Math.round(top + (span > 0 ? span * fraction : 0)));
    }

    // --- The logical reading position (ADR-015) ------------------------------
    //
    // Interpolated from @textstack/shared rather than written here twice: an
    // anchor built in this document has to resolve in the web reader, and it
    // will not if the two quote different amounts of text.
    var TS_POSITION_VERSION = ${TEXT_POSITION_VERSION};
    var TS_QUOTE_LEN = ${POSITION_QUOTE_LENGTH};
    var TS_CONTEXT_LEN = ${ANCHOR_CONTEXT_LENGTH};
    //
    // A pixel offset stops being true the moment the text reflows. What survives
    // is the text itself: the passage under the reading line, plus a little of
    // what surrounds it. That is what a highlight already is, and the resolver
    // below is the same one highlights use.

    /** The chapter's element, for scoping the text — only for its own slug. */
    function chapterElement(slug) {
      return slug && tsChapter && tsChapter.slug === slug ? tsChapter.el : null;
    }

    /**
     * The chapter's text, as the anchor offsets measure it.
     *
     * Not textContent: vocab overlays and inline translations are DOM nodes the
     * reader never wrote, and counting them would shift every offset the moment
     * a word was saved. Web excludes the same two selectors when it builds an
     * anchor -- if these two walkers ever disagree, an anchor made on the phone
     * stops resolving on the desktop.
     */
    function chapterText(el) {
      if (!el) return '';
      // Cached on the element: the extraction walks every text node, and this
      // runs on every progress message. A chapter's text never changes once it
      // is in the document, and the walker excludes the vocab decorations that
      // do get added to it.
      if (el.__tsText !== undefined) return el.__tsText;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          if (p.closest && (p.closest('[data-vocab-overlay]') || p.closest('.vocab-inline-translation'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var out = '', node;
      while ((node = walker.nextNode())) out += node.nodeValue || '';
      el.__tsText = out;
      return out;
    }

    /** Character offset of a (node, offset) pair within the chapter's text. */
    function charOffsetOf(el, node, offset) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          if (p.closest && (p.closest('[data-vocab-overlay]') || p.closest('.vocab-inline-translation'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var consumed = 0, n;
      while ((n = walker.nextNode())) {
        if (n === node) return consumed + offset;
        consumed += (n.nodeValue || '').length;
      }
      return consumed;
    }

    /** (node, offset) at a point, across the two spellings of the same API. */
    function caretAt(x, y) {
      try {
        if (document.caretPositionFromPoint) {
          var pos = document.caretPositionFromPoint(x, y);
          if (pos && pos.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
        }
        if (document.caretRangeFromPoint) {
          var r = document.caretRangeFromPoint(x, y);
          if (r) return { node: r.startContainer, offset: r.startOffset };
        }
      } catch (e) {}
      return null;
    }

    /**
     * Where the reader is, as a place in the text.
     *
     * The reading line is the same probe currentChapterBounds uses -- a quarter
     * down the viewport -- so the chapter this answers for and the chapter the
     * progress message names can never disagree.
     *
     * Returns the raw material; RN builds the position with the shared builder,
     * so both clients quote the same number of characters and resolve them the
     * same way.
     */
    window.__textstackCapturePosition = function() {
      try {
        var bounds = currentChapterBounds();
        if (!bounds) return null;
        var el = chapterElement(bounds.slug);
        if (!el) return null;
        // The reading line, clamped into the chapter's visible band. A chapter
        // shorter than a quarter of the viewport -- a poem, a preface, a clip,
        // the stub last chapter of a book -- ends ABOVE the line, so an
        // unclamped probe finds no text and the reader silently gets no logical
        // position at all, falling back to the pixel offset forever. Measured:
        // a one-paragraph chapter ends at 108px with the line at 200px.
        var rect = el.getBoundingClientRect();
        var y = Math.max(rect.top + 4, Math.min(window.innerHeight * 0.25, rect.bottom - 4));
        // A few x positions: the reading line can land in a margin, between
        // paragraphs, or on an image, and a caret there resolves to nothing.
        var caret = caretAt(24, y) || caretAt(window.innerWidth / 2, y) || caretAt(window.innerWidth - 24, y);
        if (!caret || !el.contains(caret.node)) return null;
        var span = (bounds.bottom - bounds.top) - window.innerHeight;
        var text = chapterText(el);
        var start = Math.max(0, Math.min(text.length, charOffsetOf(el, caret.node, caret.offset)));
        var exact = text.slice(start, start + TS_QUOTE_LEN);
        if (exact.length === 0) return null;
        // Shape and constants come from @textstack/shared's buildTextPosition,
        // interpolated below rather than duplicated: an anchor made here has to
        // resolve on the web, and it will not if the two quote different amounts.
        return {
          v: TS_POSITION_VERSION,
          chapterSlug: bounds.slug,
          anchor: {
            prefix: text.slice(Math.max(0, start - TS_CONTEXT_LEN), start),
            exact: exact,
            suffix: text.slice(start + exact.length, start + exact.length + TS_CONTEXT_LEN),
            startOffset: start,
            endOffset: start + exact.length
          },
          charOffset: start,
          chapterFraction: span > 0 ? Math.min(1, Math.max(0, (window.scrollY - bounds.top) / span)) : 0
        };
      } catch (e) { return null; }
    };

    /**
     * Put the reader back at a resolved character offset.
     *
     * The offset comes from RN, which resolved the anchor against the text this
     * document reported. Same Range-to-scroll path highlights use, with the
     * passage at the reading line rather than centred, and the same ack the
     * other restores send -- the write gate does not care which kind it was.
     */
    /**
     * Put a resolved position under the reading line. Shared by the cold restore
     * and by a typography reflow, which is the same problem with a shorter fuse.
     * Returns false when the position could not be placed, so the caller can
     * fall back to the chapter fraction.
     */
    function scrollToResolvedPosition(pos) {
      try {
        var api = window.__TSAnchor;
        if (!pos || !api || !api.resolvePosition) return false;
        var el = chapterElement(pos.chapterSlug);
        if (!el) return false;
        var resolved = api.resolvePosition(JSON.stringify(pos), pos.chapterSlug, chapterText(el));
        if (!resolved || resolved.kind !== 'anchor') return false;
        var loc = locateCharOffset(el, resolved.offset);
        if (!loc) return false;
        var range = document.createRange();
        range.setStart(loc.node, loc.offset);
        range.setEnd(loc.node, Math.min((loc.node.nodeValue || '').length, loc.offset + 1));
        var rect = range.getBoundingClientRect();
        scrollToInstant(Math.max(0, Math.round(window.scrollY + rect.top - window.innerHeight * 0.25)));
        return true;
      } catch (e) { return false; }
    }

    window.__textstackRestoreAnchor = function(json, restoreId) {
      try {
        // The chapter the document was built from is the one a restore can land
        // in. If the saved position names another, the resolver returns null and
        // the reader stays at the top — RN routes to that chapter instead, which
        // is a decision it can make and this document cannot.
        var slug = tsChapter ? tsChapter.slug : null;
        var el = chapterElement(slug);
        var api = window.__TSAnchor;
        if (!el || !api || !api.resolvePosition) {
          // Diagnostics, not defensiveness: each of these is a different failure
          // with a different fix, and from RN they look identical -- an ack with
          // no movement. Cost one line to tell them apart on a device.
          console.log('[diag] restoreAnchor: no target', 'slug=', slug, 'el=', !!el, 'api=', !!(api && api.resolvePosition));
          ackRestore(restoreId); return;
        }
        var resolved = api.resolvePosition(json, slug, chapterText(el));
        if (!resolved) {
          console.log('[diag] restoreAnchor: unresolved in', slug);
          ackRestore(restoreId); return;
        }
        console.log('[diag] restoreAnchor:', resolved.kind, resolved.offset != null ? resolved.offset : resolved.fraction);
        requestAnimationFrame(function() {
          try {
            if (resolved.kind === 'anchor') {
              var loc = locateCharOffset(el, resolved.offset);
              if (loc) {
                var range = document.createRange();
                range.setStart(loc.node, loc.offset);
                range.setEnd(loc.node, Math.min((loc.node.nodeValue || '').length, loc.offset + 1));
                var rect = range.getBoundingClientRect();
                // The reading line, not the top of the viewport — the same
                // quarter-down probe the position was measured against, so a
                // capture and a restore describe the same place.
                scrollToInstant(Math.max(0, Math.round(window.scrollY + rect.top - window.innerHeight * 0.25)));
              }
            } else {
              scrollToInstant(chapterScrollTarget(resolved.fraction));
            }
          } catch (e) {}
          ackRestore(restoreId);
        });
      } catch (e) {}
    };

    /** Inverse of charOffsetOf: a character offset back to (node, offset). */
    function locateCharOffset(el, target) {
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: function(n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          if (p.closest && (p.closest('[data-vocab-overlay]') || p.closest('.vocab-inline-translation'))) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var consumed = 0, node;
      while ((node = walker.nextNode())) {
        var len = (node.nodeValue || '').length;
        if (consumed + len > target) return { node: node, offset: target - consumed };
        consumed += len;
      }
      return null;
    }

    /**
     * Change typography on the LIVE document and keep the reader where they were.
     *
     * Typography used to be an input to the document string, so changing a font
     * size reloaded the WebView and re-ran the restore. Injecting the CSS
     * instead keeps the document.
     *
     * The three steps are one call because the middle one has to happen between
     * the other two: measure where the reader is BEFORE the reflow (afterwards
     * the old coordinates mean nothing), restyle, then put the same text (or,
     * failing that, the same chapter fraction) back under the reading line. The scroll fires reportProgress, so it carries a
     * restoreId and acks like any other restore — the write gate is what stops
     * the transient from being saved, and it already exists.
     */
    window.__textstackApplyTypography = function(css, restoreId) {
      try {
        // The TEXT the reader is looking at, captured before the reflow. A
        // chapter fraction is not good enough here and the device pass proved
        // it: justify plus a line-height change re-wraps paragraphs unevenly, so
        // the same fraction of a taller chapter is a different sentence -- about
        // two paragraphs out, measured on a real phone. The anchor is exact, and
        // the fraction stays as the fallback for when it resolves to nothing.
        var beforePos = window.__textstackCapturePosition ? window.__textstackCapturePosition() : null;
        var before = currentChapterBounds();
        var fraction = 0;
        if (before) {
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
          if (!scrollToResolvedPosition(beforePos)) scrollToInstant(chapterScrollTarget(fraction));
          // Highlights and vocab underlines are drawn from Range rects, and a
          // style change fires no resize event — the overlayer's own listeners
          // never hear about this one.
          try { if (_hlOverlayer) _hlOverlayer.redraw(); } catch (e) {}
          try { if (typeof vhlScheduleReposition === 'function') vhlScheduleReposition(); } catch (e) {}
          ackRestore(restoreId);
        });
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
      // Emit-on-load: the scroll-gated reportProgress only fires once the
      // reader actually moves, so a chapter the user navigates INTO records
      // nothing (and ReadingProgress.MaxChapterNumber stays unset) until they
      // scroll. Post one initial progress so ReaderShell runs its full
      // book-progress + debounced-persistence path for the DESTINATION chapter
      // immediately.
      var initBounds = currentChapterBounds();
      if (initBounds) {
        var initRelY = Math.max(0, window.scrollY - initBounds.top);
        var initSpan = (initBounds.bottom - initBounds.top) - window.innerHeight;
        var initProgress = initSpan > 0 ? Math.min(initRelY / initSpan, 1) : 0;
        lastProgress = initProgress;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'progress',
          progress: initProgress,
          chapterSlug: initBounds.slug,
          scrollY: Math.round(initRelY)
        }));
      }
    });

    // The document's one chapter. Its element is the scope a reading position
    // (ADR-015) and its anchors are measured in. One chapter per document since
    // 2026-10-03: the reader used to append the next chapter as you scrolled,
    // and "which chapter is the reader in" having two answers was the source of
    // most of the position bugs ADR-015 lists.
    var tsChapter = null;
    function registerChapter(slug, el) {
      tsChapter = el ? { slug: slug, el: el } : null;
    }

    // --- End of chapter ------------------------------------------------------
    // RN builds the model (labels already localized, which buttons apply) and
    // pushes it here; taps go back as 'chapterEnd' messages. Re-callable: RN
    // pushes again when the chapter list or the saved-word count lands, and to
    // show a load error. 'visible' is posted once, when the block first scrolls
    // into view, so RN can fetch the next chapter ahead of the tap.
    var tsEndSeen = false;
    function tsEndPost(action) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'chapterEnd', action: action }));
    }
    function tsEndCheckVisible() {
      if (tsEndSeen) return;
      var root = document.getElementById('ts-chapter-end');
      if (!root || !root.firstChild) return;
      if (root.getBoundingClientRect().top < window.innerHeight) { tsEndSeen = true; tsEndPost('visible'); }
    }
    window.addEventListener('scroll', tsEndCheckVisible, { passive: true });
    window.__tsSetChapterEnd = function(m) {
      try {
        var root = document.getElementById('ts-chapter-end');
        if (!root) return;
        root.innerHTML = '';
        if (!m) return;
        var el = function(tag, cls, text) {
          var e = document.createElement(tag);
          if (cls) e.className = cls;
          if (text != null) e.textContent = text;
          return e;
        };
        var btn = function(cls, text, action, sub) {
          var b = el('button', cls, text);
          b.type = 'button';
          if (sub) b.appendChild(el('small', null, sub));
          if (m.busy) b.disabled = true;
          b.addEventListener('click', function(e) { e.preventDefault(); tsEndPost(action); });
          return b;
        };
        root.appendChild(el('hr'));
        root.appendChild(el('div', 'ts-end__title' + (m.finished ? ' done' : ''), m.title));
        if (m.next) root.appendChild(btn('ts-end__next', m.next.label, 'next', m.next.counter));
        if (m.error) {
          root.appendChild(el('div', 'ts-end__error', m.error));
          root.appendChild(btn('ts-end__alt', m.retry, 'retry'));
        }
        if (m.discuss) root.appendChild(btn('ts-end__alt', m.discuss, 'discuss'));
        if (m.reviewWords) root.appendChild(btn('ts-end__alt', m.reviewWords, 'review'));
        if (m.library) root.appendChild(btn('ts-end__alt', m.library, 'library'));
        if (m.prev) root.appendChild(btn('ts-end__prev', m.prev.label, 'prev'));
        tsEndCheckVisible();
      } catch (e) {}
    };

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
    function hlOverlayEnabled() {
      return !!(window.__TSOverlayer && typeof window.__TSOverlayer.create === 'function');
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

    // Public entry. Accepts either an anchor object/JSON (preferred) or a
    // bare selectedText string for back-compat. Idempotent: the overlayer
    // replaces an existing key.
    function renderHighlight(id, anchor, color, fallbackText) {
      if (!color) { console.warn('[diag] renderHighlight: missing color', id); return; }
      var snippet = '';
      var anchorObj = null;
      if (typeof anchor === 'string') {
        try { anchorObj = JSON.parse(anchor); } catch (e) { anchorObj = { exact: anchor }; }
      } else if (anchor && typeof anchor === 'object') {
        anchorObj = anchor;
      }
      // Page geometry for the Original PDF viewer — its 'exact' would text-match a reflow page.
      if (anchorObj && anchorObj.kind === 'pdf') { console.warn('[diag] renderHighlight: pdf anchor in reflow', id); return; }
      if (!anchorObj || !anchorObj.exact) {
        if (fallbackText) anchorObj = { exact: fallbackText };
      }
      if (!anchorObj || !anchorObj.exact) { console.warn('[diag] renderHighlight: no anchor', id); return; }
      snippet = anchorObj.exact.length > 30 ? anchorObj.exact.slice(0, 30) + '…' : anchorObj.exact;
      var range = hlBuildRange(anchorObj);
      if (!range) { console.warn('[diag] renderHighlight NO MATCH:', id, snippet); return; }
      var res = hlPaintRangeOverlay(range, id, color);
      if (!res.ok) console.warn('[diag] renderHighlight paint failed:', id, snippet);
      else console.log('[diag] renderHighlight matched:', id, snippet);
    }

    function removeHighlight(id) {
      hlRemoveOverlay(id);
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

    // Re-apply vocab marks after DOM mutations (e.g. a re-parsed chunk of
    // body). RAF-debounced, only runs if a vocab map is loaded.
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
  <!-- data-vocab-overlay: keeps the block out of vocab underlining and out of the
       chapter text positions are measured in. Filled by __tsSetChapterEnd. -->
  <div id="ts-chapter-end" class="ts-end" data-vocab-overlay="true"></div>
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
  const chrome: ReaderChrome = {
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
