#!/usr/bin/env node
//
// The extension's checks, actually run.
//
// apps/browser-extension/README.md documents a `node --check` loop and asks the developer to
// remember it before committing. Nothing in .github/workflows mentions the
// folder, so for the life of the extension nothing has enforced it — the same
// shape as the SSG rebuild that reported success while writing nowhere, and the
// mobile OTA that published to a runtime nobody had installed. A check a person
// has to remember is a check that eventually is not run.
//
// Three things, in the order they would bite:
//
//   1. Every .js parses. A typo in background.js ships a service worker that
//      never starts, and the extension has no build step to catch it.
//   2. The manifest parses, and every file it names exists. Renaming an icon or
//      a page breaks the extension in a way no syntax check can see — Chrome
//      refuses to load the whole thing.
//   3. host_permissions carries no localhost. The README tells developers to add
//      `http://localhost:8080/*` for local work and to remove it before
//      packaging. That is a rule enforced by memory; this makes it mechanical.
//
// Run: node scripts/check-extension.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXT = join(ROOT, 'apps', 'browser-extension')
const problems = []

/** Every .js under apps/browser-extension/, recursively. */
function scripts(dir = EXT) {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return scripts(full)
    return name.endsWith('.js') ? [full] : []
  })
}

// 1 — every script parses.
for (const file of scripts()) {
  const rel = file.slice(ROOT.length + 1)
  try {
    // Piped through stdin with an explicit --input-type, NOT `node --check
    // <path>`. That is what apps/browser-extension/README.md documents, and on Node 24 it
    // exits 0 on a file containing `const x = ;` — module-syntax detection
    // swallows the parse error rather than reporting it. The documented gate
    // would have passed anything put in front of it. Verified by hand both
    // ways before this line was written.
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: readFileSync(file),
      stdio: ['pipe', 'ignore', 'pipe'],
    })
  } catch (e) {
    problems.push(`${rel} does not parse:\n  ${String(e.stderr).trim().split('\n').slice(0, 3).join('\n  ')}`)
  }
}

// 2 — the manifest parses, and everything it names is on disk.
const manifestPath = join(EXT, 'manifest.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (e) {
  problems.push(`apps/browser-extension/manifest.json does not parse: ${e.message}`)
}

if (manifest) {
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
  ].filter(Boolean)

  for (const rel of new Set(referenced)) {
    if (!existsSync(join(EXT, rel))) {
      problems.push(`apps/browser-extension/manifest.json names "${rel}", which does not exist`)
    }
  }

  // 3 — no local host permission left behind.
  for (const host of manifest.host_permissions ?? []) {
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(host)) {
      problems.push(
        `apps/browser-extension/manifest.json still grants "${host}". The README asks for this during local ` +
        `development and for its removal before packaging — remove it before merging.`
      )
    }
  }
}

if (problems.length) {
  console.error('Extension checks failed:\n')
  for (const p of problems) console.error(`  • ${p}\n`)
  process.exit(1)
}

console.log(`Extension OK — ${scripts().length} scripts parse, manifest names only files that exist.`)
