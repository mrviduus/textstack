// Test-only entry (`node build.mjs --repro`): the reader page plus `__fol.reproRenderDuringLoad`, the
// reproducer behind patches/0001. Never in v2ReaderPage.generated.ts.
//
// foliate makes the new view current before its iframe has loaded; a Paginator render in that window
// (here `max-inline-size`, which calls render() synchronously; in the wild a resize) styles a
// still-parsing XHTML document whose `body` is null and throws
// "Cannot destructure property 'style' of 'el' as it is null". With the patch: 0 errors.
import { currentView } from './page.mjs'

const isTheBug = (msg) => /destructure property 'style'/.test(String(msg))

/** Starts `tries` section loads and re-renders on every task until each lands. */
async function reproRenderDuringLoad(tries = 6) {
  const view = currentView()
  let errors = 0
  const onError = (e) => { if (isTheBug(e.message)) errors++ }
  addEventListener('error', onError)
  const { port1, port2 } = new MessageChannel()
  const tick = () => new Promise((ok) => { port2.onmessage = ok; port1.postMessage(0) })
  const r = view.renderer
  const was = r.getAttribute('max-inline-size')
  let inWindow = 0   // forced renders that met a still-parsing section (body null): the bug's window
  for (let k = 0; k < tries; k++) {
    let loaded = false
    view.addEventListener('load', () => { loaded = true }, { once: true })
    view.goTo(((view.lastLocation?.section?.current ?? 0) + 1) % view.book.sections.length)
    for (let f = 0; !loaded && f < 20000; f++) {
      if (r.getContents().some((c) => c.doc && !c.doc.body)) inWindow++
      try { r.setAttribute('max-inline-size', `${720 + (f % 2)}px`) } catch (e) { if (isTheBug(e.message)) errors++ }
      await tick()
    }
  }
  if (was === null) r.removeAttribute('max-inline-size'); else r.setAttribute('max-inline-size', was)
  // The ResizeObserver path reports asynchronously; let it land before counting.
  await new Promise((ok) => setTimeout(ok, 300))
  removeEventListener('error', onError)
  return { errors, inWindow, loads: tries }
}

window.__fol.reproRenderDuringLoad = reproRenderDuringLoad
