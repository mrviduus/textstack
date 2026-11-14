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
 * `<image>` (its href). `alt`: the img's alt, else the SVG's `aria-label` or `<title>`; '' when none.
 */
export function imageAt(target) {
  const img = target?.closest?.('img')
  if (img) {
    const src = shownUrl(img.currentSrc || img.src)
    return src ? { src, alt: img.getAttribute('alt') ?? '' } : null
  }
  const image = target?.closest?.('image')
  if (!image || image.namespaceURI !== SVG) return null
  const src = shownUrl(image.href?.baseVal || image.getAttribute('href') || image.getAttributeNS(XLINK, 'href'))
  if (!src) return null
  const svg = image.closest('svg')
  return { src, alt: svg?.getAttribute('aria-label') ?? svg?.querySelector('title')?.textContent ?? '' }
}

/** A scale in [1, MAX_SCALE]; at 1 the image is centred (no pan). */
export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(1, Number.isFinite(s) ? s : 1))

/**
 * The overlay. `open({ src, alt }, from)` shows it (scale 1, focus on it), `close()` removes it and gives focus back; each
 * posts `{ type: 'lightbox', open }` through `post`. `behind`: the element made inert while it is open (the book).
 */
export function createLightbox(doc, post, behind = () => null) {
  let box = null
  let img = null
  let returnFocus = null
  let inert = null
  let t = { s: 1, x: 0, y: 0 }
  const pointers = new Map()
  let gesture = null
  let lastTap = null

  const apply = () => {
    if (t.s === 1) t.x = t.y = 0
    img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`
  }
  const zoomTo = (s) => { t.s = clampScale(s); apply() }

  function onDown(e) {
    if (e.target.closest('button')) return
    box.setPointerCapture?.(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const [a, b] = [...pointers.values()]
    gesture = { moved: pointers.size > 1, from: { ...t }, a: { ...a }, dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 }
  }
  function onMove(e) {
    if (!gesture || !pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const [a, b] = [...pointers.values()]
    if (b && gesture.dist > 0) {
      // Pinch: the scale follows the fingers' distance.
      zoomTo(gesture.from.s * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.dist))
      return
    }
    const dx = a.x - gesture.a.x, dy = a.y - gesture.a.y
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) gesture.moved = true
    // ponytail: pan is not clamped to the image's edges; a double tap or reopening resets it.
    if (gesture.moved && t.s > 1) { t.x = gesture.from.x + dx; t.y = gesture.from.y + dy; apply() }
  }
  function onUp(e) {
    if (!pointers.delete(e.pointerId) || !gesture) return
    if (pointers.size) {
      // One finger of a pinch lifted: the other pans from here.
      const [a] = [...pointers.values()]
      gesture = { moved: true, from: { ...t }, a: { ...a }, dist: 0 }
      return
    }
    const tapped = !gesture.moved
    gesture = null
    if (!tapped) return (lastTap = null)
    // A double tap (or double click) zooms in there, or back out to fit.
    const now = e.timeStamp
    if (lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap = null
      return t.s > 1 ? zoomTo(1) : zoomTo(DOUBLE_TAP_SCALE)
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY }
  }
  function onWheel(e) {
    e.preventDefault()
    zoomTo(t.s * Math.exp(-e.deltaY / 300))
  }
  function onKey(e) {
    // Nothing behind the dialog takes a key while it is open (no page turn); Escape closes it.
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  /** `from`: where focus goes back to on close (the tapped section's frame), else what had it. */
  function open({ src, alt }, from = null) {
    if (box) close()
    returnFocus = from ?? doc.activeElement
    box = doc.createElement('div')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', alt.trim() || 'Image')
    box.tabIndex = -1
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none;outline:none'
    img = doc.createElement('img')
    img.src = src
    img.alt = alt
    img.draggable = false
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;user-select:none;-webkit-user-select:none;pointer-events:none'
    const close_ = doc.createElement('button')
    close_.type = 'button'
    close_.setAttribute('aria-label', 'Close')
    close_.textContent = '×'
    close_.style.cssText = 'position:absolute;top:12px;right:12px;width:44px;height:44px;border:0;border-radius:22px;background:rgba(255,255,255,.2);color:#fff;font:28px/44px system-ui,sans-serif;cursor:pointer'
    close_.addEventListener('click', () => close())
    box.append(img, close_)
    box.addEventListener('pointerdown', onDown)
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerup', onUp)
    box.addEventListener('pointercancel', onUp)
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('keydown', onKey)
    // Its clicks are its own: never a `tap` of the page document.
    box.addEventListener('click', (e) => e.stopPropagation())
    t = { s: 1, x: 0, y: 0 }
    apply()
    doc.body.append(box)
    inert = behind()
    if (inert) inert.inert = true
    box.focus()
    post({ type: 'lightbox', open: true })
  }

  function close() {
    if (!box) return
    box.remove()
    box = img = gesture = lastTap = null
    pointers.clear()
    if (inert) inert.inert = false
    inert = null
    returnFocus?.focus?.()
    returnFocus = null
    post({ type: 'lightbox', open: false })
  }

  return { open, close, isOpen: () => !!box }
}
