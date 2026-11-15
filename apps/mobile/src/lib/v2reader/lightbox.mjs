// The image lightbox (#1265): a tapped EPUB image full screen, zoom and pan, in the page's own document. The overlay
// shows the image element the section already loaded, by the same `blob:`/`data:` URL (img-src blob: data:): no CSP
// directive widened, no image bytes sent to the host. Book strings reach it as attributes and text only.

const SVG = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'
export const MAX_SCALE = 8
export const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 300
const TAP_SLOP_PX = 10

/** What the page itself allows an image from (its img-src): anything else would not load here anyway. */
const shownUrl = (u) => (typeof u === 'string' && /^(blob|data):/i.test(u) ? u : null)

/**
 * The image under a tap in a section document, `{ src, alt }`, or null: an `<img>` (its current source) or an SVG
 * `<image>` (its href). `alt`: the img's alt, else the SVG's `aria-label`, else a `<title>` child of the `<image>` or of
 * its nearest `<g>`/`<svg>`; '' when none.
 */
export function imageAt(target) {
  const img = target?.closest?.('img')
  if (img) {
    const src = shownUrl(img.currentSrc || img.src)
    return src ? { src, alt: img.getAttribute('alt') ?? '' } : null
  }
  const image = target?.closest?.('image')
  if (!image || image.namespaceURI !== SVG) return null
  const src = shownUrl(image.getAttribute('href') || image.getAttributeNS(XLINK, 'href'))
  if (!src) return null
  // A `<title>` that is the image's own child, else one of its nearest `<g>` or `<svg>`: direct children only.
  const titleOf = (el) => (el ? [...el.children].find((c) => c.localName === 'title')?.textContent : undefined)
  const svg = image.closest('svg')
  return { src, alt: svg?.getAttribute('aria-label') ?? titleOf(image) ?? titleOf(image.parentElement?.closest('g, svg')) ?? '' }
}

/** A scale in [1, MAX_SCALE]. */
export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(1, Number.isFinite(s) ? s : 1))

/**
 * The pan kept on screen: the image (`iw`×`ih` at scale 1, centred in a `w`×`h` box) scaled by `t.s` moves at most
 * until its edge meets the box's, and not at all along a side it does not fill. At scale 1 it is centred.
 */
export function clampPan(t, { w, h, iw, ih }) {
  const mx = Math.max(0, (t.s * iw - w) / 2)
  const my = Math.max(0, (t.s * ih - h) / 2)
  return { s: t.s, x: Math.min(mx, Math.max(-mx, t.x)), y: Math.min(my, Math.max(-my, t.y)) }
}

/**
 * `from` (`{ s, x, y }`: translate then scale, about the box's centre) zoomed to `s` so the image point that was under
 * `f0` (box px from its centre) is under `f1` now: the same point for the wheel and a double tap, the fingers' midpoint
 * as it moves for a pinch. Then clamped (`clampPan`).
 */
export function zoomAt(from, s, f0, f1, size) {
  const k = clampScale(s) / from.s
  return clampPan({ s: clampScale(s), x: f1.x - k * (f0.x - from.x), y: f1.y - k * (f0.y - from.y) }, size)
}

/** The lightbox's own words before the host sends its translations (#1267, `labels`). */
export const DEFAULT_LABELS = { image: 'Image', close: 'Close' }
/** At most this many characters per label: a host's translation, never a book's text. */
export const MAX_LABEL = 200

/**
 * The host's `labels(l)` (#1267): each of `image` (the dialog's name when the image has no alt text) and `close` (its
 * button's name) as a non-blank string up to MAX_LABEL characters, else the one held before (`was`).
 */
export function readLabels(l, was = DEFAULT_LABELS) {
  const one = (k) => {
    const v = l?.[k]
    return typeof v === 'string' && v.trim() && v.length <= MAX_LABEL ? v : was[k]
  }
  return { image: one('image'), close: one('close') }
}

/**
 * The overlay. `open({ src, alt }, from)` shows it (scale 1, focus on it), `close()` removes it and gives focus back; each
 * posts `{ type: 'lightbox', open }` through `post`. `behind`: the element made inert while it is open (the book).
 * `labels(l)`: the host's translations of its two words (`readLabels`).
 */
export function createLightbox(doc, post, behind = () => null) {
  let labels = DEFAULT_LABELS
  let box = null
  let img = null
  let closeButton = null
  let returnFocus = null
  let inert = null
  let t = { s: 1, x: 0, y: 0 }
  const pointers = new Map()
  let gesture = null
  let lastTap = null

  /**
   * The box and the image as laid out at scale 1 (box px: `clientWidth` is whole px, the dialog is the viewport, which is
   * too). Before the image has decoded it has no layout size yet: its natural
   * size fitted into the box as its CSS fits it (`max-width/max-height: 100%`, never upscaled), so the first gesture
   * already keeps its focus and its pan.
   */
  const size = () => {
    const [w, h] = [box.clientWidth, box.clientHeight]
    // Its box on screen over the scale: fractional (offsetWidth rounds to whole px, and the clamp would miss the edge).
    const r = img.getBoundingClientRect()
    if (r.width && r.height) return { w, h, iw: r.width / t.s, ih: r.height / t.s }
    const k = img.naturalWidth && img.naturalHeight ? Math.min(1, w / img.naturalWidth, h / img.naturalHeight) : 0
    return { w, h, iw: img.naturalWidth * k, ih: img.naturalHeight * k }
  }
  /** A point of the viewport as box px from its centre. */
  const fromCentre = (p) => ({ x: p.x - box.clientWidth / 2, y: p.y - box.clientHeight / 2 })
  const show = (next) => {
    t = next
    img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`
  }
  const midpoint = ([a, b]) => fromCentre({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

  /** A gesture from the pointers down now: one pans, two pinch about their midpoint. */
  const startGesture = (moved) => {
    const ps = [...pointers.values()]
    gesture = { moved, from: { ...t }, a: { ...ps[0] }, dist: ps[1] ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0, mid: ps[1] && midpoint(ps) }
  }
  function onDown(e) {
    if (e.target.closest('button')) return
    box.setPointerCapture?.(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    startGesture(pointers.size > 1)
  }
  function onMove(e) {
    if (!gesture || !pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const ps = [...pointers.values()]
    if (ps[1] && gesture.dist > 0) {
      const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)
      return show(zoomAt(gesture.from, gesture.from.s * (dist / gesture.dist), gesture.mid, midpoint(ps), size()))
    }
    const dx = ps[0].x - gesture.a.x, dy = ps[0].y - gesture.a.y
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) gesture.moved = true
    if (gesture.moved && t.s > 1) show(clampPan({ s: t.s, x: gesture.from.x + dx, y: gesture.from.y + dy }, size()))
  }
  function onUp(e) {
    if (!pointers.delete(e.pointerId) || !gesture) return
    // One finger of a pinch lifted: the other pans from here.
    if (pointers.size) return startGesture(true)
    const tapped = !gesture.moved
    gesture = null
    if (!tapped) return (lastTap = null)
    // A double tap (or double click) zooms in there, or back out to fit.
    const now = e.timeStamp
    if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null
      const f = fromCentre({ x: e.clientX, y: e.clientY })
      return show(t.s > 1 ? { s: 1, x: 0, y: 0 } : zoomAt(t, DOUBLE_TAP_SCALE, f, f, size()))
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY }
  }
  /**
   * A cancelled pointer (the system took it) is never a tap, nor half of a double tap. One of a pinch: the pointers
   * still down go on (the other pans from here); the last one: the gesture ends.
   */
  function onCancel(e) {
    if (!pointers.delete(e.pointerId)) return
    lastTap = null
    if (pointers.size) startGesture(true)
    else gesture = null
  }
  function onWheel(e) {
    e.preventDefault()
    const f = fromCentre({ x: e.clientX, y: e.clientY })
    show(zoomAt(t, t.s * Math.exp(-e.deltaY / 300), f, f, size()))
  }
  function onKey(e) {
    // Nothing behind the dialog takes a key while it is open (no page turn); Escape closes it; Tab stays on its one
    // control (aria-modal: focus never leaves it).
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      closeButton.focus()
    }
  }

  /** `from`: where focus goes back to on close (the tapped section's frame), else what had it. */
  function open({ src, alt }, from = null) {
    if (box) close()
    returnFocus = from ?? doc.activeElement
    box = doc.createElement('div')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', alt.trim() || labels.image)
    box.tabIndex = -1
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;outline:none'
    img = doc.createElement('img')
    img.src = src
    img.alt = alt
    img.draggable = false
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;user-select:none;-webkit-user-select:none;pointer-events:none'
    closeButton = doc.createElement('button')
    closeButton.type = 'button'
    closeButton.setAttribute('aria-label', labels.close)
    closeButton.textContent = '×'
    closeButton.style.cssText = 'position:absolute;top:12px;right:12px;width:44px;height:44px;border:0;border-radius:22px;background:rgba(255,255,255,.2);color:#fff;font:28px/44px system-ui,sans-serif;cursor:pointer'
    closeButton.addEventListener('click', () => close())
    box.append(img, closeButton)
    box.addEventListener('pointerdown', onDown)
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerup', onUp)
    box.addEventListener('pointercancel', onCancel)
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('keydown', onKey)
    // Its clicks are its own: never a `tap` of the page document.
    box.addEventListener('click', (e) => e.stopPropagation())
    doc.body.append(box)
    show({ s: 1, x: 0, y: 0 })
    inert = behind()
    if (inert) inert.inert = true
    box.focus()
    post({ type: 'lightbox', open: true })
  }

  function close() {
    if (!box) return
    box.remove()
    box = img = closeButton = gesture = lastTap = null
    pointers.clear()
    if (inert) inert.inert = false
    inert = null
    // A section frame gets focus as foliate gives it (its window): focusing the element would scroll foliate's
    // container and move the place.
    if (returnFocus?.contentWindow) returnFocus.contentWindow.focus()
    else returnFocus?.focus?.({ preventScroll: true })
    returnFocus = null
    post({ type: 'lightbox', open: false })
  }

  /** The host's words for the next opening (`readLabels`; one open now keeps its own). */
  const setLabels = (l) => { labels = readLabels(l, labels) }

  return { open, close, labels: setLabels }
}
