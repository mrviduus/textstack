// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SCALE, clampPan, clampScale, createLightbox, imageAt, zoomAt } from './lightbox.mjs'

// #1265: the real gestures (pinch, drag, double tap) run in Chromium in formats.check.mjs; here the DOM rules.

const SVG = 'http://www.w3.org/2000/svg'
const XLINK = 'http://www.w3.org/1999/xlink'
afterEach(() => { document.body.innerHTML = '' })

const html = (s: string) => {
  document.body.innerHTML = s
  return document.body.firstElementChild!
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

describe('v2 lightbox imageAt', () => {
  it('img_ItsBlobSourceAndAlt_FromAChildTargetToo', () => {
    const img = html('<img src="blob:null/abc" alt="A map">')
    expect(imageAt(img)).toEqual({ src: 'blob:null/abc', alt: 'A map' })
    expect(imageAt(html('<img src="data:image/png;base64,AA">'))).toEqual({ src: 'data:image/png;base64,AA', alt: '' })
  })

  it('aSourceThePageCannotShow_NotAnImage', () => {
    for (const src of ['https://evil.tst/x.png', 'javascript:alert(1)', 'file:///x.png']) expect(imageAt(html(`<img src="${src}">`))).toBeNull()
    expect(imageAt(html('<p>text</p>'))).toBeNull()
    expect(imageAt(null)).toBeNull()
  })

  it('svgImage_ItsHrefAndTheSvgTitle_AnHtmlImageElementIsNot', () => {
    const svg = document.createElementNS(SVG, 'svg')
    const title = document.createElementNS(SVG, 'title')
    title.textContent = 'A chart'
    const image = document.createElementNS(SVG, 'image')
    image.setAttributeNS(XLINK, 'xlink:href', 'blob:null/svg')
    svg.append(title, image)
    document.body.append(svg)
    expect(imageAt(image)).toEqual({ src: 'blob:null/svg', alt: 'A chart' })
    const g = document.createElementNS(SVG, 'g')
    const nested = document.createElementNS(SVG, 'title')
    nested.textContent = 'nested'
    g.append(nested)
    svg.prepend(g)
    expect(imageAt(image)?.alt).toBe('A chart')
    title.remove()
    expect(imageAt(image)?.alt).toBe('')
    svg.setAttribute('aria-label', 'Labelled')
    expect(imageAt(image)?.alt).toBe('Labelled')
    // An `image` that is not SVG's (an unknown HTML element) is nothing.
    const htmlImage = document.createElement('image')
    htmlImage.setAttribute('href', 'blob:null/x')
    document.body.append(htmlImage)
    expect(imageAt(htmlImage)).toBeNull()
  })

  it('clampScale_OneToMax', () => {
    expect([clampScale(0.2), clampScale(3), clampScale(99), clampScale(NaN)]).toEqual([1, 3, MAX_SCALE, 1])
  })
})

describe('v2 lightbox zoom and pan', () => {
  // A 1000×600 box, the image 800×400 at scale 1.
  const box = { w: 1000, h: 600, iw: 800, ih: 400 }

  it('clampPan_TheImageEdgeMeetsTheBoxEdge_NoPanAlongASideItDoesNotFill', () => {
    // ×2: 1600×800, so it may move 300 sideways and 100 up or down.
    expect(clampPan({ s: 2, x: 900, y: -900 }, box)).toEqual({ s: 2, x: 300, y: -100 })
    expect(clampPan({ s: 2, x: -50, y: 40 }, box)).toEqual({ s: 2, x: -50, y: 40 })
    // ×1.2: 960×480, inside the box both ways: centred.
    expect(clampPan({ s: 1.2, x: 30, y: 30 }, box)).toEqual({ s: 1.2, x: 0, y: 0 })
  })

  it('zoomAt_ThePointUnderTheFocusStaysThere', () => {
    // From fit, ×2 about a point 100 px right of the centre: that image point (100 at ×1) is at 200 at ×2, so the
    // pan is −100 to keep it under the focus.
    expect(zoomAt({ s: 1, x: 0, y: 0 }, 2, { x: 100, y: 0 }, { x: 100, y: 0 }, box)).toEqual({ s: 2, x: -100, y: 0 })
    // About the centre: no pan.
    expect(zoomAt({ s: 1, x: 0, y: 0 }, 2, { x: 0, y: 0 }, { x: 0, y: 0 }, box)).toEqual({ s: 2, x: 0, y: 0 })
    // Out from a panned ×4 to ×2 about the centre: the pan halves.
    expect(zoomAt({ s: 4, x: 200, y: 80 }, 2, { x: 0, y: 0 }, { x: 0, y: 0 }, box)).toEqual({ s: 2, x: 100, y: 40 })
  })

  it('zoomAt_APinchsMidpointMoving_PansWithIt_ClampedAndScaleBounded', () => {
    expect(zoomAt({ s: 2, x: 0, y: 0 }, 2, { x: 0, y: 0 }, { x: 50, y: 20 }, box)).toEqual({ s: 2, x: 50, y: 20 })
    expect(zoomAt({ s: 2, x: 0, y: 0 }, 2, { x: 0, y: 0 }, { x: 5000, y: 0 }, box).x).toBe(300)
    expect(zoomAt({ s: 2, x: 0, y: 0 }, 99, { x: 0, y: 0 }, { x: 0, y: 0 }, box).s).toBe(MAX_SCALE)
    expect(zoomAt({ s: 2, x: 100, y: 0 }, 0.1, { x: 0, y: 0 }, { x: 0, y: 0 }, box)).toEqual({ s: 1, x: 0, y: 0 })
  })
})

describe('v2 lightbox overlay', () => {
  const setup = () => {
    const sent: unknown[] = []
    const behind = document.createElement('div')
    const from = document.createElement('button')
    document.body.append(behind, from)
    from.focus()
    return { sent, behind, from, lb: createLightbox(document, (m: unknown) => sent.push(m), () => behind) }
  }

  it('open_ADialogLabelledByTheAltAsText_FocusedTheBookInert_ClosePutsFocusBack', () => {
    const { sent, behind, from, lb } = setup()
    const alt = '<img src=x onerror="window.__pwned=1">'
    lb.open({ src: 'blob:null/a', alt }, from)
    const d = dialog()!
    expect(d.getAttribute('aria-label')).toBe(alt)
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.querySelectorAll('img')).toHaveLength(1)
    expect(d.querySelector('img')!.getAttribute('src')).toBe('blob:null/a')
    expect(document.activeElement).toBe(d)
    expect((behind as HTMLElement & { inert: boolean }).inert).toBe(true)
    expect(sent).toEqual([{ type: 'lightbox', open: true }])
    lb.close()
    expect(dialog()).toBeNull()
    expect((behind as HTMLElement & { inert: boolean }).inert).toBe(false)
    expect(document.activeElement).toBe(from)
    expect(sent).toEqual([{ type: 'lightbox', open: true }, { type: 'lightbox', open: false }])
    lb.close()
    expect(sent).toHaveLength(2)
  })

  it('noAlt_LabelledImage', () => {
    const { lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '  ' })
    expect(dialog()!.getAttribute('aria-label')).toBe('Image')
  })

  it('keys_StayInTheDialog_EscapeCloses', () => {
    const { lb } = setup()
    const reached: string[] = []
    document.addEventListener('keydown', (e) => reached.push(e.key))
    lb.open({ src: 'blob:null/a', alt: '' })
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(dialog()).not.toBeNull()
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(dialog()).toBeNull()
    expect(reached).toEqual([])
  })

  it('closeButton_Closes_ItsClickIsNoPageTap', () => {
    const { lb } = setup()
    const taps: unknown[] = []
    document.addEventListener('click', (e) => taps.push(e))
    lb.open({ src: 'blob:null/a', alt: '' })
    dialog()!.querySelector('button')!.click()
    expect(dialog()).toBeNull()
    expect(taps).toEqual([])
  })

  it('wheel_ZoomsIn_ReopenedAtScaleOne', () => {
    const { lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '' })
    const img = () => dialog()!.querySelector('img')!
    expect(img().style.transform).toBe('translate(0px, 0px) scale(1)')
    dialog()!.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }))
    expect(img().style.transform).toMatch(/scale\(2\.7/)
    dialog()!.dispatchEvent(new WheelEvent('wheel', { deltaY: 3000, bubbles: true, cancelable: true }))
    expect(img().style.transform).toBe('translate(0px, 0px) scale(1)')
    dialog()!.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true, cancelable: true }))
    lb.close()
    lb.open({ src: 'blob:null/b', alt: '' })
    expect(img().style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('tab_FocusStaysOnTheDialogsOneControl', () => {
    const { lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '' })
    const button = dialog()!.querySelector('button')!
    for (const from of [dialog()!, button]) {
      const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      from.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(button)
    }
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    button.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button)
  })

  it('aCancelledPointer_IsNoTap_NeverHalfOfADoubleTap', () => {
    const { lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '' })
    const d = dialog()!
    const pointer = (type: string) => d.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }), { pointerId: 1 }))
    const scale = () => d.querySelector('img')!.style.transform
    pointer('pointerdown')
    pointer('pointerup')
    pointer('pointerdown')
    pointer('pointercancel')
    expect(scale()).toBe('translate(0px, 0px) scale(1)')
    // A real second tap right after the first does zoom in.
    pointer('pointerdown')
    pointer('pointerup')
    pointer('pointerdown')
    pointer('pointerup')
    expect(scale()).toMatch(/scale\(2\.5\)/)
  })

  it('close_ASectionFrameGetsFocusThroughItsWindow_NotTheElement', () => {
    const { lb } = setup()
    const frame = document.createElement('iframe')
    document.body.append(frame)
    let byWindow = 0, byElement = 0
    frame.contentWindow!.focus = () => { byWindow++ }
    frame.focus = () => { byElement++ }
    lb.open({ src: 'blob:null/a', alt: '' }, frame)
    lb.close()
    expect([byWindow, byElement]).toEqual([1, 0])
  })

  it('openWhileOpen_OneDialog_TheFirstClosed', () => {
    const { sent, lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '' })
    lb.open({ src: 'blob:null/b', alt: '' })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(sent).toEqual([{ type: 'lightbox', open: true }, { type: 'lightbox', open: false }, { type: 'lightbox', open: true }])
  })
})
