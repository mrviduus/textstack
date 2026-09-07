#!/usr/bin/env node
// Bundles the mobile WebView entry points into vanilla-JS IIFE strings and
// writes them as constants under apps/mobile/src/lib/.
//
// Run via `pnpm -C apps/web build:mobile-overlay`. The definitions live in
// mobile-bundles.mjs, shared with check-mobile-overlay.mjs so the guard cannot
// disagree with what this writes.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BUNDLES, renderBundle } from './mobile-bundles.mjs'

for (const bundle of BUNDLES) {
  const { content, length } = await renderBundle(bundle)
  await mkdir(dirname(bundle.out), { recursive: true })
  await writeFile(bundle.out, content, 'utf8')
  console.log(`wrote ${bundle.out} (${length} chars bundle)`)
}
