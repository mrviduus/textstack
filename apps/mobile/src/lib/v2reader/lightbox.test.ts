// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SCALE, clampScale, createLightbox, imageAt } from './lightbox.mjs'

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
    svg.setAttribute('aria-label', 'Labelled')
    expect(imageAt(image)?.alt).toBe('Labelled')
    // An `image` that is not SVG's (an unknown HTML element) is nothing.
    expect(imageAt(html('<image href="blob:null/x"></image>'))).toBeNull()
  })

  it('clampScale_OneToMax', () => {
    expect([clampScale(0.2), clampScale(3), clampScale(99), clampScale(NaN)]).toEqual([1, 3, MAX_SCALE, 1])
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
    expect(lb.isOpen()).toBe(true)
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(lb.isOpen()).toBe(false)
    expect(reached).toEqual([])
  })

  it('closeButton_Closes_ItsClickIsNoPageTap', () => {
    const { lb } = setup()
    const taps: unknown[] = []
    document.addEventListener('click', (e) => taps.push(e))
    lb.open({ src: 'blob:null/a', alt: '' })
    dialog()!.querySelector('button')!.click()
    expect(lb.isOpen()).toBe(false)
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

  it('openWhileOpen_OneDialog_TheFirstClosed', () => {
    const { sent, lb } = setup()
    lb.open({ src: 'blob:null/a', alt: '' })
    lb.open({ src: 'blob:null/b', alt: '' })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(sent).toEqual([{ type: 'lightbox', open: true }, { type: 'lightbox', open: false }, { type: 'lightbox', open: true }])
  })
})
