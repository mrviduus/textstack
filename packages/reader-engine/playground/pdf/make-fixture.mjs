// Writes fixture.pdf: the first 40 Letter pages of a playground chapter, printed by Chromium (Phase 5
// answer 8a: a generated text PDF in CI, < 300 KB). Run from the repo root after a change, commit the file:
//   node packages/reader-engine/playground/pdf/make-fixture.mjs
import { chromium } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const here = import.meta.dirname
const html = await readFile(resolve(here, '../chapters/ulysses-15.html'), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{font:12pt/1.5 Georgia,serif}</style>${html}`)
const pdf = await page.pdf({
  format: 'Letter',
  pageRanges: '1-40',
  margin: { top: '0.8in', bottom: '0.8in', left: '0.8in', right: '0.8in' },
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  // A visible page number: the e2e and a human can see which page is on screen.
  footerTemplate: '<div style="font-size:10pt;width:100%;text-align:center">Page <span class="pageNumber"></span></div>',
})
await browser.close()
await writeFile(resolve(here, 'fixture.pdf'), pdf)
console.log(`fixture.pdf: ${pdf.length} bytes`)
