// HTML clips (owner decision 5, M5): an upload whose file is an article's HTML ("Send to TextStack",
// book_files.format 'html'). The page reads it as a one-section book, sanitized here first: the page's CSP
// still holds for it, this is the second wall. Pure: page.mjs and clip.test.ts.

/** Kept as they are (their attributes filtered). Any other element is unwrapped: its children stay. */
const KEEP = new Set(('a abbr article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em '
  + 'figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section '
  + 'small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr').split(' '))
/** Removed with everything inside: code, embedded documents, forms, foreign markup, and what parses differently twice. */
const DROP = new Set(('script style link meta base title head noscript template iframe frame frameset object embed applet portal '
  + 'form input button select option textarea svg math video audio source track canvas dialog xmp plaintext noembed noframes').split(' '))
/**
 * Attributes kept on any kept element; `href` (a) only with a safe URL. Every other one goes (on*, style, srcset…). An
 * image keeps a `data:` src only (the page's CSP is `img-src blob: data:`); any other becomes its alt text.
 */
const ATTRS = new Set(['id', 'lang', 'dir', 'title', 'alt', 'colspan', 'rowspan', 'datetime'])
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i
const SAFE_SRC = /^data:image\//i

const XHTML = 'http://www.w3.org/1999/xhtml'

/** `body`'s subtree, in place: only KEEP elements with ATTRS (+ a safe href/src), no comments. */
export function sanitizeClip(body) {
  const comments = body.ownerDocument.createTreeWalker(body, 128 /* NodeFilter.SHOW_COMMENT */)
  const dead = []
  while (comments.nextNode()) dead.push(comments.currentNode)
  dead.forEach((c) => c.remove())
  for (const el of [...body.querySelectorAll('*')]) {
    const name = el.localName
    const html = el.namespaceURI === XHTML
    if (!html || DROP.has(name)) el.remove()
    else if (!KEEP.has(name)) unwrap(el)
    else if (name === 'img' && !SAFE_SRC.test(el.getAttribute('src') ?? '')) el.replaceWith(el.getAttribute('alt') ?? '')
    else for (const { name: a, value } of [...el.attributes]) {
      if (!(ATTRS.has(a) || (a === 'href' && name === 'a' && SAFE_HREF.test(value)) || (a === 'src' && name === 'img' && SAFE_SRC.test(value)))) el.removeAttribute(a)
    }
  }
  return body
}

/** `el`'s children in its place (a loop: a spread of 100k children overflows the call stack). */
function unwrap(el) {
  while (el.firstChild) el.before(el.firstChild)
  el.remove()
}

/**
 * The clip's bytes (UTF-8 HTML, a whole page or a fragment) as a sanitized HTML document string: a fresh
 * document (charset declared, the source's `lang`) holding the sanitized body. `title`: the source's <title>
 * or first <h1> ('' when none: the host falls back to its own).
 */
export function clipDocument(bytes, parser = new DOMParser()) {
  // Every clip is stored as UTF-8 (UserBookService.ClipAsync); TextDecoder drops a UTF-8 BOM.
  const src = parser.parseFromString(new TextDecoder().decode(bytes), 'text/html')
  const title = (src.querySelector('title')?.textContent || src.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const lang = src.documentElement.getAttribute('lang') ?? ''
  sanitizeClip(src.body)
  const out = parser.parseFromString('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', 'text/html')
  if (/^[A-Za-z0-9-]{1,35}$/.test(lang)) out.documentElement.setAttribute('lang', lang)
  for (const n of [...src.body.childNodes]) out.body.append(out.importNode(n, true))
  return { html: `<!DOCTYPE html>${out.documentElement.outerHTML}`, title, lang }
}

/**
 * A foliate book of one section from a clip's bytes (fb2.js's shape): its document a blob: URL of the
 * sanitized HTML, no contents (the host's own title stands for it). `destroy` revokes the URL.
 */
export function clipBook(bytes) {
  const { html, title, lang } = clipDocument(bytes)
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const anchor = (id) => (doc) => (id ? doc.getElementById(id) : null)
  return {
    metadata: { title, language: lang },
    sections: [{ id: 0, load: () => url, createDocument: () => new DOMParser().parseFromString(html, 'text/html'), size: blob.size, linear: 'yes' }],
    toc: [],
    resolveHref: (href) => ({ index: 0, anchor: anchor(String(href).split('#')[1]) }),
    splitTOCHref: (href) => [0, String(href ?? '').split('#')[1]],
    getTOCFragment: (doc, id) => anchor(id)(doc),
    isExternal: (uri) => /^\w+:/i.test(uri),
    destroy: () => URL.revokeObjectURL(url),
  }
}
