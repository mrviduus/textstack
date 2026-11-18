// content.js — injected on demand (with lib/readability.js) into the active tab
// via chrome.scripting.executeScript. Runs in the PAGE's isolated content-script
// world as a CLASSIC script (not a module), so it defines a global helper that a
// follow-up executeScript({ func }) call invokes.
//
// It does NOT message the background itself — background.js injects the files,
// then calls window.__textstackExtract(mode) and reads the returned value. This
// keeps all network/auth logic in the service worker.

(function () {
  // Idempotent: re-injection (e.g. second clip on the same tab) must not redefine.
  if (window.__textstackExtract) return;

  /**
   * Extract clean article content.
   * @param {"page"|"selection"} mode
   * @returns {{title,byline,content,excerpt,lang,ok,error?}}
   */
  window.__textstackExtract = function (mode) {
    try {
      const lang =
        document.documentElement.getAttribute("lang") ||
        document.querySelector("meta[http-equiv='content-language']")?.content ||
        "en";
      const langShort = String(lang).trim().split(/[-_]/)[0] || "en";

      if (mode === "selection") {
        return extractSelection(langShort);
      }
      return extractPage(langShort);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };

  function readabilityAvailable() {
    return typeof Readability === "function";
  }

  function extractPage(lang) {
    if (!readabilityAvailable()) {
      // Graceful degradation: ship the raw <body> HTML; the server still stores it.
      return {
        ok: true,
        title: document.title || "Untitled",
        byline: metaAuthor(),
        content: document.body ? document.body.innerHTML : "",
        excerpt: "",
        lang,
      };
    }
    // Readability MUTATES the document — always parse a clone.
    const clone = document.cloneNode(true);
    // eslint-disable-next-line no-undef
    const article = new Readability(clone).parse();
    if (!article || !article.content) {
      return {
        ok: true,
        title: document.title || "Untitled",
        byline: metaAuthor(),
        content: document.body ? document.body.innerHTML : "",
        excerpt: "",
        lang,
      };
    }
    return {
      ok: true,
      title: article.title || document.title || "Untitled",
      byline: article.byline || metaAuthor(),
      content: article.content,
      excerpt: article.excerpt || "",
      lang: article.lang || lang,
    };
  }

  function extractSelection(lang) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // Nothing selected → fall back to whole-page extraction.
      return extractPage(lang);
    }

    // Build a standalone document from the selected range's cloned contents so
    // Readability can score it; fall back to raw selection HTML if that fails.
    const container = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) {
      container.appendChild(sel.getRangeAt(i).cloneContents());
    }
    const rawHtml = container.innerHTML;
    const selText = sel.toString().trim();
    const title = (selText.split("\n")[0] || document.title || "Selection").slice(0, 120);

    if (readabilityAvailable()) {
      try {
        const doc = document.implementation.createHTMLDocument("selection");
        const article = doc.createElement("article");
        article.innerHTML = rawHtml;
        doc.body.appendChild(article);
        // eslint-disable-next-line no-undef
        const parsed = new Readability(doc).parse();
        if (parsed && parsed.content) {
          return {
            ok: true,
            title: parsed.title || title,
            byline: parsed.byline || metaAuthor(),
            content: parsed.content,
            excerpt: parsed.excerpt || selText.slice(0, 200),
            lang: parsed.lang || lang,
          };
        }
      } catch {
        /* fall through to raw selection */
      }
    }

    return {
      ok: true,
      title,
      byline: metaAuthor(),
      content: `<div>${rawHtml}</div>`,
      excerpt: selText.slice(0, 200),
      lang,
    };
  }

  function metaAuthor() {
    return (
      document.querySelector("meta[name='author']")?.content ||
      document.querySelector("meta[property='article:author']")?.content ||
      ""
    );
  }
})();
