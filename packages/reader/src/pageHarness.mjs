// The Chromium checks' one way to drive the committed page (#1557): formats.check, sandbox.check and pdfgate.
// Checks only, never the app.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeBookOrigin } from './bookOriginRoute.mjs'

// apps/web's Playwright, as build.mjs takes apps/web's esbuild: no new dependency.
export const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/package.json'))('@playwright/test')

/**
 * A new page of `target` (a Browser or BrowserContext) as the Android host has it: the `ReactNativeWebView` bridge
 * in the top window, every host message pushed to `messages` (then `onMessage`), and, given `dir`, the book origin
 * routed to it (bookOriginRoute.mjs). The rest of the options go to newPage.
 */
export async function hostPage(target, { dir, fileFor, messages, onMessage, ...opts }) {
  const page = await target.newPage(opts)
  if (dir) await routeBookOrigin(page, dir, fileFor)
  await page.exposeFunction('__toHost', (json) => { const m = JSON.parse(json); messages.push(m); onMessage?.(m) })
  await page.addInitScript(() => { if (window === top) window.ReactNativeWebView = { postMessage: (json) => window.__toHost(json) } })
  return page
}

/** The section frames (blob:), but those in `stale`. */
const sectionFrames = (page, stale = new Set()) => page.frames().filter((f) => f.url().startsWith('blob:') && !stale.has(f))

/** Helpers over a host page and its `messages`; a wait gives up after `timeoutMs`. */
export function drive(page, messages, timeoutMs) {
  const call = (js) => page.evaluate(js)
  /** The first message from `from` on that matches. */
  const waitFor = async (from, match, what) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await page.waitForTimeout(50)) {
      const m = messages.slice(from).find(match)
      if (m) return m
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  /**
   * Opens `url` as `name`; resolves with `opened` or `open-failed` (plus `from`, the frames before it as `stale`,
   * `t0` and `openMs`), after restoring `stored` and its `restored` for an opened book.
   */
  const open = async (url, name, stored = null, format = null) => {
    const from = messages.length
    const stale = new Set(page.frames())
    const t0 = Date.now()
    await call(`window.__fol.openUrl(${JSON.stringify(url)}, ${JSON.stringify(name)}, ${JSON.stringify(format)})`)
    const m = await waitFor(from, (x) => (x.type === 'opened' || x.type === 'open-failed') && (x.book?.name ?? x.name) === name, `${name} to open`)
    const openMs = Date.now() - t0
    if (m.type === 'opened') {
      await call(`window.__fol.restore(${JSON.stringify(stored)})`)
      m.restored = await waitFor(from, (x) => x.type === 'restored', `${name} restored`)
    }
    return { ...m, from, stale, t0, openMs }
  }
  /** Polls the section frames, but those in `stale` (an earlier book's), until one passes `probe`, run inside it. */
  const shown = async (probe, stale) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await page.waitForTimeout(100)) {
      for (const f of sectionFrames(page, stale)) if (await f.evaluate(probe).catch(() => false)) return true
    }
    return false
  }
  /** The first truthy `probe` result in a section frame, else null. */
  const framesValue = async (probe) => {
    for (const f of sectionFrames(page)) { const v = await f.evaluate(probe).catch(() => null); if (v) return v }
    return null
  }
  return { call, waitFor, open, shown, framesValue }
}
