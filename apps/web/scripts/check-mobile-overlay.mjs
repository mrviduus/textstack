#!/usr/bin/env node
// Drift guard for the mobile WebView bundles. Re-renders each one and fails
// non-zero if the committed file differs, so a PR that edits
// packages/reader-overlay/src/* or the engine without regenerating cannot merge. A bundle
// with a `budget` also fails when it grows past it.

import { readFile } from 'node:fs/promises'
import { BUNDLES, renderBundle } from './mobile-bundles.mjs'

let stale = false
for (const bundle of BUNDLES) {
  const { content, length } = await renderBundle(bundle)
  if (bundle.budget && length > bundle.budget) {
    console.error(`\n[check:mobile-overlay] ${bundle.out} is ${length} chars, over its ${bundle.budget} budget.\n`)
    stale = true
  }
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
