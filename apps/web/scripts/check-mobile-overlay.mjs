#!/usr/bin/env node
// Drift guard for the mobile WebView bundles. Re-renders each one and fails
// non-zero if the committed file differs, so a PR that edits
// packages/reader-overlay/src/* without regenerating cannot merge.

import { readFile } from 'node:fs/promises'
import { BUNDLES, renderBundle } from './mobile-bundles.mjs'

let stale = false
for (const bundle of BUNDLES) {
  const { content } = await renderBundle(bundle)
  const actual = await readFile(bundle.out, 'utf8').catch(() => null)
  if (actual !== content) {
    console.error(`\n[check:mobile-overlay] ${bundle.out} is out of date.\n`)
    stale = true
  } else {
    console.log(`[check:mobile-overlay] ${bundle.out} is up to date.`)
  }
}

if (stale) {
  console.error('Run: pnpm -C apps/web build:mobile-overlay\n')
  process.exit(1)
}
