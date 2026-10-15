// Scroll-direction detector for the reader WebView: both engine documents (`buildEngineReaderHtml`,
// `buildPdfEngineHtml`) inline it. Kept as a raw JS string (not TS) because it is injected into the
// document; its own string so it can be unit-tested in isolation (scrollDirDetector.test.ts).
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
