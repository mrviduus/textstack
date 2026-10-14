/// <reference types="vite/client" />
// The fixed layout on a real PDF in a real browser (Playwright, fixed.e2e.ts) and a page to look at:
// `pnpm -C packages/reader-engine playground` → http://localhost:5180/pdf.html?page=20.
// This page is the host: it brings pdf.js and reads the bytes by HTTP ranges, as the apps will.
import * as pdfjs from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Locator } from '../src/api'
import { createEngine } from '../src/engine'
import { fixedLayout } from '../src/fixed'
import { locatorToPdfAnchor, pdfAnchorToLocator } from '../src/mappers'

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

const url = './pdf/fixture.pdf'
// The length first (`read` needs it): one byte, and the total from Content-Range.
const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } })
const length = Number(probe.headers.get('Content-Range')?.split('/')[1])
const reads: [number, number][] = []
async function read(begin: number, end: number): Promise<Uint8Array> {
  reads.push([begin, end])
  const r = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
  if (r.status === 401 || r.status === 403) throw { code: 'pdf-auth' }
  if (r.status !== 206) throw new Error(`HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

const root = document.getElementById('reader')!
const engine = createEngine(root, { fixed: fixedLayout(pdfjs) })
const where = document.getElementById('where')!
engine.on('relocated', (e) => { where.textContent = `page ${e.locator.locations.position} (${e.reason})` })
let pageCount = 0
engine.on('ready', (e) => { pageCount = e.pageCount ?? 0 })
const errors: unknown[] = []
engine.on('error', (e) => errors.push(e))

const n = Number(new URLSearchParams(location.search).get('page'))
const at: Locator | undefined = n ? { type: 'application/pdf', locations: { position: n } } : undefined
const opened = await engine.open({ layout: 'fixed', pdf: { length, read } }, at)

const pg = {
  locatorToPdfAnchor,
  pdfAnchorToLocator,
  length,
  reads,
  errors,
  opened,
  pageCount: () => pageCount,
  /** Pages with a canvas now. */
  canvases: () => Array.from(document.querySelectorAll('[data-page]')).filter((el) => el.querySelector('canvas')).map((el) => Number((el as HTMLElement).dataset.page)),
  /** Page n's top on screen. */
  top: (n: number) => document.querySelector(`[data-page="${n}"]`)!.getBoundingClientRect().top,
}
Object.assign(window, { engine, pdfPage: pg })
document.body.dataset.ready = 'true'
