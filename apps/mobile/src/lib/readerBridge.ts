// Shared selection/interaction bridge for the reader WebView.
//
// This is the SINGLE source for the DOM→native bridge that both the reflow
// reader (`buildReaderHtml`) and the Original-layout PDF viewer
// (`buildPdfViewerHtml`) embed verbatim — extracted so the two readers can
// never drift. It contains ONLY the code that is identical for both:
//
//   - console/error forwarder → RN postMessage (diagnostics)
//   - scroll-direction detector (drives immersive chrome reveal/hide)
//   - hold-to-select word (wordRangeAtPoint / selectWordAtPoint) + tap handling
//   - drag/long-press selection → selectionchange → dispatch to RN
//   - anchor + sentence extraction helpers the above depend on
//
// It declares `var _hlOverlayer = null;` (the highlight overlayer handle) so the
// tap/selection guards resolve in BOTH contexts; the reflow reader's highlight
// code assigns it lazily; the PDF viewer paints its highlights itself (`__setPdfHighlights`).
//
// Reflow-specific concerns (progress, scroll-restore, citation scroll, infinite
// scroll, chapter tracking, highlight PAINT, the vocab underline layer, the
// image lightbox) stay in readerHtml.ts. The two scripts share global scope in
// the document, so cross-references (e.g. reflow's `hlEnsureOverlayer` assigning
// `_hlOverlayer`) resolve at call time.
//
// NB: kept as a raw JS string (not TS) because it is injected into the WebView
// document, exactly as it lived inline before the extraction. Behavior is
// byte-for-byte the same code — only its location changed.

// Scroll-direction detector — its own string so it can be unit-tested in
// isolation (scrollDirDetector.test.ts); interpolated into the bridge below.
export const SCROLL_DIR_DETECTOR = `
    /**
     * Scroll direction detector — drives immersive chrome reveal.
     *
     * Mirrors ElevenReader's pattern: bars stay hidden while the reader
     * moves forward (scrolls down), and reveal as soon as the reader
     * starts going back (scrolls up) to re-read something.
     *
     * Design note (user feedback): "one swipe up should be enough".
     * Previously we required an UP threshold of 14px AFTER a baseline
     * reset on pivot — so exiting a down-run actually needed ~20px of
     * upward travel before bars appeared. That felt laggy. Now: once
     * the user has pivoted from a down-run, ANY upward motion reveals
     * bars immediately (no threshold). We still apply a mild UP
     * threshold from the bars-visible state so incidental upward drift
     * while reading doesn't endlessly re-fire the reveal.
     *
     * Thresholds are asymmetric — trivial to reveal, sticky to hide
     * (larger DOWN_THRESHOLD) — to avoid flicker from tiny wobbles
     * while reading.
     */
    var scrollDirBaseline = window.scrollY;
    var scrollDirLast = null; // 'up' | 'down' | null
    var SCROLL_UP_THRESHOLD = 6;
    var SCROLL_DOWN_THRESHOLD = 48;
    function emitScrollDir(dir, y) {
      scrollDirBaseline = y;
      if (scrollDirLast !== dir) {
        scrollDirLast = dir;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'scrollDir', dir: dir }));
      }
    }
    function reportScrollDir() {
      var y = window.scrollY;
      var delta = y - scrollDirBaseline;
      if (delta < 0) {
        // Any upward motion while we were scrolling DOWN (or haven't
        // decided yet) reveals bars immediately — one swipe is enough.
        // If bars are already revealed (scrollDirLast === 'up'), wait
        // for the small UP threshold so baseline drifts smoothly with
        // continued upward motion without spamming messages.
        if (scrollDirLast !== 'up' || delta <= -SCROLL_UP_THRESHOLD) {
          emitScrollDir('up', y);
        }
      } else if (delta >= SCROLL_DOWN_THRESHOLD) {
        emitScrollDir('down', y);
      }
      // Small downward motion below the threshold leaves the baseline alone:
      // the 48px threshold IS the wobble guard. Resetting it here on every
      // event meant slow scrolling never accumulated 48px and never hid.
    }
    window.addEventListener('scroll', reportScrollDir, { passive: true });
    // RN owns bar visibility (taps toggle it there). Resync so the next
    // scroll is measured against what the reader actually sees.
    window.__tsSetBars = function (visible) {
      scrollDirLast = visible ? 'up' : 'down';
      scrollDirBaseline = window.scrollY;
    };
`

export const READER_SELECTION_BRIDGE = `
    // Diagnostic console forwarder — routes WebView console.log/warn/error
    // and uncaught errors to RN via postMessage. RN surfaces via console.warn
    // in __DEV__. Bug-report Phase 1: lets us see WHY word-tap / selection /
    // highlight-render / TTS fail on device without attaching a remote debugger.
    (function() {
      function post(level, args) {
        try {
          var parts = [];
          for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (typeof a === 'string') parts.push(a);
            else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
          }
          window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'log', level: level, msg: parts.join(' ')
          }));
        } catch (e) {}
      }
      var orig = { log: console.log, warn: console.warn, error: console.error };
      console.log = function() { post('log', arguments); orig.log.apply(console, arguments); };
      console.warn = function() { post('warn', arguments); orig.warn.apply(console, arguments); };
      console.error = function() { post('error', arguments); orig.error.apply(console, arguments); };
      window.addEventListener('error', function(e) {
        post('error', ['window.onerror:', e.message, e.filename + ':' + e.lineno + ':' + e.colno]);
      });
      window.addEventListener('unhandledrejection', function(e) {
        post('error', ['unhandledrejection:', e.reason && e.reason.message || String(e.reason)]);
      });
    })();

    // Highlight overlayer handle — owned here so the tap/selection guards below
    // resolve in both readers. Reflow assigns it lazily (hlEnsureOverlayer); the
    // PDF viewer leaves it null and paints its own highlights (__setPdfHighlights).
    var _hlOverlayer = null;

    ${SCROLL_DIR_DETECTOR}

    /**
     * Tap-to-word: programmatically select the word under the tap point
     * so single-tap behaves like the web reader (WordPopup + auto-save +
     * auto-TTS). iOS WebView's default is long-press-to-select, which is
     * too friction-heavy for vocab flow. We use caretPositionFromPoint /
     * caretRangeFromPoint to resolve text-node + offset, expand to word
     * boundaries with a unicode letter/number class, then set the native
     * Selection — the existing selectionchange listener handles the
     * rest (pulse, message dispatch, RN-side save + TTS).
     */
    var WORD_RE = /[\\p{L}\\p{N}'-]/u;
    function wordRangeAtPoint(x, y) {
      var node = null, offset = 0;
      if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(x, y);
        if (pos) { node = pos.offsetNode; offset = pos.offset; }
      }
      if (!node && document.caretRangeFromPoint) {
        var r = document.caretRangeFromPoint(x, y);
        if (r) { node = r.startContainer; offset = r.startOffset; }
      }
      if (!node || node.nodeType !== 3) return null;
      var text = node.textContent || '';
      if (!text) return null;
      // Skip vocab-inline-translation nodes (the small italic gloss
      // above an underlined word) — tapping those should select the
      // underlying word, not the translation text.
      var parent = node.parentElement;
      if (parent && parent.classList && parent.classList.contains('vocab-inline-translation')) return null;
      var start = offset;
      var end = offset;
      while (start > 0 && WORD_RE.test(text.charAt(start - 1))) start--;
      while (end < text.length && WORD_RE.test(text.charAt(end))) end++;
      if (start === end) return null;
      // Skip purely numeric "words"
      var candidate = text.slice(start, end);
      if (!/\\p{L}/u.test(candidate)) return null;
      // Sanity cap. 40 was rejecting legitimate long compounds like
      // "Unterscheidungsvermögen" / "Schadenfreudegesellschaft" (B-11).
      // 80 is well past any real word but still blocks entire
      // paragraph-blob pathological cases.
      if (candidate.length > 80) return null;
      var range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      return range;
    }
    function selectWordAtPoint(x, y) {
      var range = wordRangeAtPoint(x, y);
      if (!range) { console.log('[diag] wordRangeAtPoint null at', x, y); return false; }
      var text = range.toString().trim();
      if (!text) return false;
      console.log('[diag] selected word:', text);
      // Do NOT touch window.getSelection() here. Android WebView reacts to
      // a programmatic Selection by spawning its own ActionMode (Copy /
      // Share / Select all), which immediately dismisses our RN popup.
      // Instead, post the selection directly from the range — our popup
      // opens, native UI stays silent. Drag-select still uses the normal
      // Selection API flow via selectionchange.
      try { applyTapPulseRange(range); } catch(e) {}
      var sentence = '';
      try { sentence = extractSentence(range.startContainer); } catch(e) {}
      var anchor = null;
      try { anchor = getRangeAnchor(range); } catch(e) {}
      // Long suppression window: we never touch Selection API here, so any
      // selectionchange that fires within ~1.5s of a tap is native noise
      // (Android ActionMode spawn/dismiss) that would wrongly clear our popup.
      _suppressSelectionChangeUntil = Date.now() + 1500;
      // Foliate-js justAnchored: block the overlay hit-test on the synthetic
      // click that iOS replays ~300ms after touchend — otherwise the same
      // tap fires both 'selection' and 'highlightTap' when a word sits inside
      // a user-highlight rect.
      if (_hlOverlayer && _hlOverlayer.markJustAnchored) _hlOverlayer.markJustAnchored();
      _lastDispatchedText = text;
      _lastDispatchWasTap = true;
      // mode:'tap' tells RN to always route to WordCard regardless of whitespace —
      // sentence captures the surrounding paragraph but the popup is always
      // single-word for the tapped word.
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'selection',
        mode: 'tap',
        text: text,
        sentence: sentence,
        anchor: anchor,
        token: ++_selToken
      }));
      return true;
    }

    // The tapped word stays marked for as long as the toolbar is open.
    //
    // It used to be a 650ms fade. The word lit up, went out, and the toolbar
    // stayed — four unlabelled icons hovering over nothing, with no way to tell
    // which word Translate or Speak was about to act on. QA reported it as
    // "the selected word is not marked"; the selection was correct all along,
    // only its evidence expired.
    //
    // Deliberately NOT window.getSelection(): touching the Selection API here
    // raises Android's ActionMode over our own toolbar. See selectWordAtPoint.
    var _wordMarkSpan = null;

    function clearWordMark(repaint) {
      try {
        var span = _wordMarkSpan;
        _wordMarkSpan = null;
        if (!span || !span.parentNode) return;
        var parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parent.normalize();
        // Unwrapping moves the word's text node, which collapses every live Range on it — the vocab
        // underline painted while the mark was up (SEL-1). Repaint once with the current map, on a
        // real close only: markRange re-marks with a Range computed before this, which a repaint destroys.
        if (repaint && typeof markVocabWords === 'function' && typeof _currentVocabMap === 'object' && _currentVocabMap) markVocabWords(_currentVocabMap);
      } catch(e) {}
    }

    function markRange(range) {
      try {
        clearWordMark();
        var span = document.createElement('span');
        span.className = 'ts-word-mark';
        range.surroundContents(span);
        _wordMarkSpan = span;
      } catch(e) {}
    }

    function applyTapPulseRange(range) { markRange(range); }

    // RN clears the mark when the selection toolbar closes — the toolbar owns
    // the lifecycle, so it also owns the ending. Every selection posted to RN carries a token. RN hands the closed selection's token back
    // here; once a newer selection (or a collapse) has been posted, that clear is stale and does
    // nothing — it must not wipe the newer one (SEL-1). markOnly keeps the native range.
    // Random base: a clear for the previous chapter's document never matches this one's (SEL-1).
    var _selToken = Math.floor(Math.random() * 1e12);
    window.__tsClearSelection = function(token, markOnly) {
      if (typeof token === 'number' && token !== _selToken) return;
      if (!markOnly) { try { window.getSelection && window.getSelection().removeAllRanges(); } catch(e) {} }
      clearWordMark(true);
    };

    // The chapter's own element, or the body where there is none (the PDF
    // viewer). Context cut from the body picked up the template's whitespace,
    // the inline registerChapter script and the end-of-chapter labels -- text
    // no other client has, so it could only ever fail to match.
    function anchorScope(range) {
      var n = range.startContainer;
      var el = n && n.nodeType === 1 ? n : n && n.parentElement;
      return (el && el.closest && el.closest('[data-chapter-slug]')) || document.body;
    }

    function getRangeAnchor(range) {
      var scope = anchorScope(range);
      // Range.toString(), untrimmed -- the same raw text nodes the prefix,
      // the suffix and both resolvers read. Selection.toString() serializes
      // like innerText (paragraph breaks become newlines), so an exact taken
      // from it matched nothing once a selection crossed a paragraph.
      var text = range.toString();
      var preRange = document.createRange();
      preRange.setStart(scope, 0);
      preRange.setEnd(range.startContainer, range.startOffset);
      // 30, not 50: the resolver compares 30 characters of context
      // (ANCHOR_CONTEXT_LENGTH in @textstack/shared), so a longer prefix only
      // made anchors created here score worse when the same book was opened
      // on the web.
      var prefix = preRange.toString().slice(-30);
      var sufRange = document.createRange();
      sufRange.setStart(range.endContainer, range.endOffset);
      sufRange.setEnd(scope, scope.childNodes.length);
      var suffix = sufRange.toString().substring(0, 30);
      return { prefix: prefix, exact: text, suffix: suffix };
    }

    /**
     * Suppress the selectionchange listener briefly after a programmatic
     * dispatch. iOS WebKit may fire multiple selectionchange events for a
     * single removeAllRanges() + addRange() pair (one for each mutation).
     * A boolean flag only absorbs the first — a later "empty" event would
     * race through and post { text: '' } → RN clears the popup.
     *
     * Timestamp guard absorbs all events inside the window, which covers
     * the typical 50-100ms settle time on iOS 17+ WebKit.
     */
    var _suppressSelectionChangeUntil = 0;
    // Longest passage the server-backed actions accept: Tts:MaxTextLength and
    // OpenAI:Translate:MaxTextLength are both 500. A longer selection used to
    // be dropped here without a message, so the toolbar never appeared at all
    // and Copy and Highlight — which have no limit — were lost with it. It is
    // dispatched now, flagged, and the toolbar disables only what cannot work.
    var SELECTION_MAX_CHARS = 500;
    var _lastDispatchedText = '';
    // When the last dispatch came from the tap path (selectWordAtPoint),
    // we MUST NOT notify the parent of a "selection cleared" event on the
    // next native collapse — there is no selection to clear in the first
    // place (tap doesn't touch window.getSelection). Without this guard
    // the native ActionMode dismiss nukes the WordCard milliseconds after
    // it opens.
    var _lastDispatchWasTap = false;

    function dispatchSelection() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { console.log('[diag] dispatchSelection: no selection'); return; }
      var text = sel.toString().trim();
      if (!text) { console.log('[diag] dispatchSelection: empty text'); return; }
      if (text.length > SELECTION_MAX_CHARS) { console.log('[diag] dispatchSelection: text too long', text.length); return; }
      if (!text.includes(' ') && text.length <= 50) applyTapPulse(sel);
      var sentence = '';
      try { sentence = extractSentence(sel.anchorNode); } catch(e) {}
      var anchor = null;
      try { anchor = getSelectionAnchor(); } catch(e) {}
      _suppressSelectionChangeUntil = Date.now() + 200;
      _lastDispatchedText = text;
      _lastDispatchWasTap = false;
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'selection',
        text: text,
        sentence: sentence,
        anchor: anchor,
        token: ++_selToken
      }));
    }

    // Tap detection for immersive mode (touchend, not click — click unreliable in RN WebView)
    var lastTapTime = 0;
    var tapTimeout = null;
    var touchStartX = 0, touchStartY = 0;
    var touchStartTime = 0;

    // Word-action gate (Item A): a deliberate held press — not a brushing
    // tap — resolves the word and opens the WordCard. A quick tap on a word
    // does nothing, so accidental screen brushes no longer auto-fire TTS /
    // translate / Explain (LLM token spend).
    //   LONGPRESS_MS  — hold duration before the word fires.
    //   DRAG_TOLERANCE — movement (px) that reclassifies the touch as a
    //                    scroll / swipe / page-turn and cancels the hold.
    var LONGPRESS_MS = 450;
    var DRAG_TOLERANCE = 8;
    // After the timer has fired a single-word selection, a drag past this
    // larger threshold means the finger is extending a native multi-word
    // selection — release the suppression window so the extension's
    // selectionchange is honoured rather than swallowed (FIX 4).
    var SELECT_EXTEND_TOLERANCE = 16;
    var wordPressTimer = null;
    var _wordPressFired = false;

    // Single cancel path so every abort (drag past tolerance, touchend,
    // touchcancel) clears the pending hold the same way and resets the
    // fired flag — prevents a stale timer firing a WordCard for a word the
    // finger already left (FIX 1).
    function cancelWordPress() {
      if (wordPressTimer) { clearTimeout(wordPressTimer); wordPressTimer = null; }
      _wordPressFired = false;
    }

    document.addEventListener('touchstart', function(e) {
      touchStartX = e.changedTouches[0].clientX;
      touchStartY = e.changedTouches[0].clientY;
      touchStartTime = Date.now();
      cancelWordPress();

      var target = e.target;
      // .ts-end is the end-of-chapter block: its buttons own their taps.
      var onLink = target && (target.tagName === 'A' || (target.closest && target.closest('a,.ts-end')));
      // Don't arm the hold over links — let the anchor own the gesture.
      if (onLink) return;
      // Capture start coords now; the timer resolves the word at the point
      // where the finger first landed (not wherever it drifts to).
      var startX = touchStartX, startY = touchStartY;
      wordPressTimer = setTimeout(function() {
        wordPressTimer = null;
        // Highlight tap just fired — skip word-select so a hold doesn't
        // open both the highlight editor and the WordCard.
        if (_hlOverlayer && _hlOverlayer.isJustAnchored && _hlOverlayer.isJustAnchored()) return;
        if (selectWordAtPoint(startX, startY)) {
          _wordPressFired = true;
          // RN can't reach expo-haptics from inside the WebView — ask it to
          // buzz a light/selection impact so the hold feels deliberate.
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'wordEngage' }));
        }
      }, LONGPRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
      var mx = e.changedTouches[0].clientX;
      var my = e.changedTouches[0].clientY;
      var movedX = Math.abs(mx - touchStartX);
      var movedY = Math.abs(my - touchStartY);
      // After the timer fired its single-word selection, a clear drag means
      // the user is extending a native selection. Cancel the suppression
      // window so the extension's selectionchange isn't swallowed for 1.5s
      // (FIX 4). Needs on-device validation of the extend-from-tap gesture.
      if (_wordPressFired) {
        if (movedX > SELECT_EXTEND_TOLERANCE || movedY > SELECT_EXTEND_TOLERANCE) {
          _suppressSelectionChangeUntil = 0;
        }
        return;
      }
      if (!wordPressTimer) return;
      if (movedX > DRAG_TOLERANCE || movedY > DRAG_TOLERANCE) {
        // Scroll / swipe / page-turn — not a deliberate hold. Cancel.
        cancelWordPress();
      }
    }, { passive: true });

    // touchcancel — the OS took the gesture (incoming call, notification
    // shade, scroll takeover, WebView losing the touch). touchend never
    // fires here, so without this the pending timer would open a WordCard
    // (+ haptic + auto-TTS) for a word the finger already left (FIX 1).
    document.addEventListener('touchcancel', function() {
      cancelWordPress();
    }, { passive: true });

    document.addEventListener('touchend', function(e) {
      if (wordPressTimer) { clearTimeout(wordPressTimer); wordPressTimer = null; }

      // The hold already resolved the word on the timer — don't also run the
      // immersive-toggle / page-turn fallback for this same touch.
      if (_wordPressFired) { _wordPressFired = false; return; }

      var tx = e.changedTouches[0].clientX;
      var ty = e.changedTouches[0].clientY;
      var dx = tx - touchStartX;
      var dy = ty - touchStartY;
      var dur = Date.now() - touchStartTime;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return; // scroll, not tap
      // Long-press: Android/iOS create a multi-word selection during the
      // hold, then fire touchend on release. If we treat that touchend as
      // a tap and call removeAllRanges() we destroy the selection the
      // user just made. selectionchange already dispatched it to RN, so
      // bail out here and let the native handles + RN SelectionActionBar
      // own the lifecycle. Use LONGPRESS_MS so a release in the old
      // 351–449ms dead band still falls through to quick-tap handling
      // (word-swallow / immersive toggle). The hold timer is already
      // cleared at the top of touchend, so this can't double-fire (FIX 5).
      if (dur > LONGPRESS_MS) return;
      var target = e.target;
      if (target.tagName === 'A' || target.closest('a,.ts-end')) return;

      // Short tap with an active selection in the DOM. selectWordAtPoint
      // never touches the Selection API, so any non-collapsed selection
      // here came from a native long-press drag. Preserve multi-word /
      // long selections (the user just spent effort building them);
      // only collapse short single-word leftovers so the next tap can
      // fire word-select cleanly.
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        var selText = sel.toString().trim();
        if (selText.indexOf(' ') !== -1 || selText.length > 30) return;
        sel.removeAllRanges();
        return;
      }

      // Highlight tap just fired — skip the fallback so a single tap doesn't
      // open the highlight editor twice.
      if (_hlOverlayer && _hlOverlayer.isJustAnchored && _hlOverlayer.isJustAnchored()) return;

      // PDF persistent-highlight tap (M2/L4). The rects are pointer-events:none
      // (so a drag starting over a highlight still selects text), which means
      // e.target is never the rect and closest('.pdf-hl-rect') can't match — so
      // the PDF viewer exposes a geometric hit-test. A plain tap resolving to a
      // highlight opens the RN edit modal and MUST early-return so it does NOT
      // also post 'tap' (toggle bars).
      // No-op in the reflow reader (global is undefined there).
      if (typeof window.__pdfHighlightAtPoint === 'function') {
        var _hlId = null;
        try { _hlId = window.__pdfHighlightAtPoint(tx, ty); } catch (e) {}
        if (_hlId) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'highlightTap', highlightId: _hlId }));
          return;
        }
      }

      // A tap here toggles the bars, INCLUDING a tap that lands on a word.
      //
      // This used to end by calling wordRangeAtPoint and returning — swallow
      // the tap so an accidental brush could not toggle the chrome. The cost was
      // not obvious from here: text covers almost the whole screen, so in
      // practice tapping the page did nothing at all. QA took two screenshots a
      // second apart and got byte-identical images, then discovered the only way
      // to reach the table of contents after reading half a chapter was to
      // scroll back up through what they had just read.
      //
      // Tap-to-toggle is the convention in every reader people arrive from, and
      // nothing in the app taught them otherwise. The brush it guarded against is
      // already excluded above: a graze while scrolling moves more than 10px, a
      // hold runs past LONGPRESS_MS, a drag leaves a selection, and a highlight
      // or link tap has already returned. What is left — stationary, under
      // 450ms, on plain text — is someone tapping the page.
      var now = Date.now();
      if (now - lastTapTime < 300) {
        if (tapTimeout) { clearTimeout(tapTimeout); tapTimeout = null; }
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
      if (tapTimeout) clearTimeout(tapTimeout);
      tapTimeout = setTimeout(function() {
        tapTimeout = null;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'tap' }));
      }, 300);
    }, { passive: true });

    // Text selection — sentence extraction (walks up to a block ancestor).
    function extractSentence(node) {
      if (!node) return '';
      var el = node.nodeType === 3 ? node.parentElement : node;
      while (el && !['P','DIV','LI','BLOCKQUOTE','TD','FIGCAPTION'].includes(el.tagName)) {
        el = el.parentElement;
      }
      return el ? el.textContent.trim().substring(0, 500) : '';
    }

    function getSelectionAnchor() {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      return getRangeAnchor(sel.getRangeAt(0));
    }

    // Tap pulse: wrap selection in temporary span with animation
    function applyTapPulse(sel) {
      // Native drag selections already paint themselves via ::selection, so this
      // only adds the mark for the single-word case the tap path shares.
      try {
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        markRange(sel.getRangeAt(0));
      } catch(e) {}
    }

    console.log('[diag] attaching selectionchange listener');
    // 220ms debounce — iOS WebKit fires selectionchange repeatedly during
    // magnifier drag and snap-back, sending intermediate single-word states
    // before the user releases on a phrase. Without debounce the UI flickers
    // between WordCard and SelectionActionBar mid-drag. Matches PWA's
    // STABILIZE_MS in useTextSelection.
    var _selChangeTimer = null;
    function _runSelectionDispatch() {
      _selChangeTimer = null;
      if (_hlOverlayer && _hlOverlayer.isJustAnchored && _hlOverlayer.isJustAnchored()) return;
      var sel = window.getSelection();
      // The suppression window swallows NOISE about the selection we just made
      // — an ActionMode spawning or dismissing, iOS re-firing the same range.
      // It used to swallow everything, including the reader extending a
      // long-press into a phrase, and that is the bug it caused: after the
      // 450ms hold selects a word, dragging the handles out to a sentence
      // produces selectionchange events that all landed inside the 1500ms
      // window and were dropped. The app never heard about the sentence, so
      // Listen read the single word it still had — the "I selected a sentence
      // and it read one word" report. Verified on an emulator: the identical
      // gesture delivered the full sentence the moment the window had expired.
      //
      // The release path that was supposed to prevent this — touchmove setting
      // the deadline to 0 once the finger passes SELECT_EXTEND_TOLERANCE —
      // carried the comment "Needs on-device validation" and does not fire:
      // once Android's selection ActionMode owns the gesture, the page stops
      // receiving touchmove at all.
      //
      // So the window no longer gates a genuinely different, non-empty
      // selection. Noise cannot invent one: an echo repeats the text we last
      // sent (caught by the dedupe below) and a dismiss collapses it (caught
      // here).
      var suppressed = Date.now() < _suppressSelectionChangeUntil;
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        // A collapse inside the window is the ActionMode going away, not the
        // reader letting go.
        if (suppressed) return;
        // Only notify parent of "selection cleared" when WE previously
        // dispatched a drag-select via this listener. If the last dispatch
        // was a tap, there was no Selection-API selection to begin with,
        // so reporting "empty" would incorrectly tear down the WordCard.
        if (_lastDispatchedText && !_lastDispatchWasTap) {
          console.log('[diag] selectionchange: posting empty (prior drag-select collapsed)');
          _selToken++;
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'selection', text: '' }));
        }
        _lastDispatchedText = '';
        _lastDispatchWasTap = false;
        return;
      }
      var text = sel.toString().trim();
      // Drop duplicates — if the user re-selected the exact same text (e.g.
      // iOS magnifier re-firing), don't re-render the popup. This is also what
      // absorbs the echo of a selection we made ourselves, which is why the
      // window above no longer needs to.
      if (text === _lastDispatchedText) return;
      // No tap-pulse here. range.surroundContents() mutates the DOM under
      // the live Selection — Android aborts the long-press extension when
      // the selection's text node gets split mid-drag, so the user only
      // ever gets one word. selectWordAtPoint paints its own pulse via
      // applyTapPulseRange (which doesn't touch Selection); long-press
      // already has the native handles for visual feedback.
      var sentence = '';
      try { sentence = extractSentence(sel.anchorNode); } catch(e) {}
      var anchor = null;
      try { anchor = getSelectionAnchor(); } catch(e) {}
      _lastDispatchedText = text;
      // mode:'drag' = native drag / long-press. RN routes by content: single
      // word → WordCard, multi-word → SelectionActionBar (palette).
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'selection',
        mode: 'drag',
        text: text,
        sentence: sentence,
        anchor: anchor,
        tooLong: text.length > SELECTION_MAX_CHARS,
        token: ++_selToken
      }));
    }
    document.addEventListener('selectionchange', function() {
      if (_selChangeTimer) clearTimeout(_selChangeTimer);
      _selChangeTimer = setTimeout(_runSelectionDispatch, 220);
    });
`
