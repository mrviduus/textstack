#!/usr/bin/env node
//
// Known advisories, listed on purpose. Anything else fails the build.
//
// Dependabot alerts were disabled on this repository for its whole life. That
// is how a patched `dompurify` — the XSS sanitiser itself — sat available for
// months while the vulnerable version shipped to every visitor. Not even a hard
// fix: the declared range already allowed the patched version, and only a stale
// lockfile held it back. It was found by running `pnpm audit` by hand.
//
// The alerts are on now. This exists because a setting somebody can switch off
// is not a check, and because the alert list will always hold the advisories
// below — permanent entries are how a list stops being read. Here they are text,
// with dates and reasons, in a file that shows up in review.
//
// **Three outcomes, and the third is the one that was missing.**
//   • clean                                → exit 0
//   • an advisory nobody has written down  → exit 1, someone must look at it
//   • an entry here that no longer appears → exit 1, it is fixed; delete it
//   • COULD NOT CHECK                      → exit 1, and says so in those words
//
// That last one is why this file was rewritten on 2026-09-28. It used to ask
// `pnpm audit`, and on the Expo SDK 57 dependency tree pnpm 11.8.0 produced no
// report and never exited: CI killed the job at its ten-minute ceiling with an
// empty log. A red cross that means "we did not check" is indistinguishable
// from one that means "we found something", which is the worst shape a security
// check can fail in. Worse still, the old code had a hatch that exited **zero**
// when the lookup looked broken — so a failed lookup could read as a clean tree.
//
// `pnpm audit` only ever asked the npm registry. So this asks the registry, and
// there is no subprocess left that can decline to exit.
//
// Run: node scripts/check-advisories.mjs

import { execFileSync } from 'node:child_process'
import { readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The endpoint `npm audit` and `pnpm audit` both use underneath. */
export const REGISTRY_BULK_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

/** Long enough for a slow registry, short enough that a wedged one is a
 *  half-minute answer rather than a ten-minute mystery. */
export const REQUEST_TIMEOUT_MS = 30_000

/** Names per request. The tree is ~900 names; one body would probably be fine,
 *  and "probably" is not a reason to find out in CI at 3am. */
export const BATCH_SIZE = 200

/** Thrown for anything that means "no verdict": a malformed lockfile, a
 *  registry that will not answer, a body that is not the shape promised. Never
 *  for a finding. The distinction is the entire point of this file. */
export class LookupFailed extends Error {}

/**
 * One workspace, one lockfile — and this reads exactly that one.
 *
 * Turning Dependabot alerts on produced fourteen findings where `pnpm audit`
 * reported three. The eleven extra ones all named the same manifest:
 * `packages/shared/pnpm-lock.yaml`, last written 2026-05-24 and orphaned by the
 * move to a pnpm workspace three months later. `packages/shared` resolves
 * through the root lockfile — it declares `vitest: catalog:` — so its own
 * lockfile installed nothing and pinned vitest 2.1.9, vite 5.4.21 and postcss
 * 8.5.10 in the repository where a scanner would find them.
 *
 * Neither tool was wrong. They were reading different files. A second lockfile
 * is a place advisories can hide from the audit, so there must not be one.
 *
 * Asks git rather than walking the tree: a lockfile someone has lying around
 * untracked is their business, a committed one is the repository's. Walking was
 * tried first and died on a broken CocoaPods header symlink under
 * apps/mobile/ios/Pods, which is a good argument for the narrower question.
 */
export function strayLockfiles({ run = execFileSync } = {}) {
  let out
  try {
    out = run('git', ['ls-files', '--', '*pnpm-lock.yaml', '*package-lock.json', '*yarn.lock'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch (e) {
    // No git, no checkout, no answer — and "no answer" is not "no stray
    // lockfiles". Same rule as everywhere else in this file: an infrastructure
    // failure is reported as one, never folded into a verdict. Found by
    // accident, running this script from outside the repository.
    throw new LookupFailed(`could not ask git for stray lockfiles: ${e.message}`)
  }
  return out.split('\n').filter((p) => p.trim() && p !== 'pnpm-lock.yaml')
}

/**
 * Keyed by GHSA id — stable, unlike a version range, which moves the moment a
 * transitive dependency does.
 *
 * `needs` records the version the advisory demands. When a real fix appears
 * upstream the entry stops being true, and the note below it stops being an
 * excuse — so re-read these before extending the list, not after.
 */
export const KNOWN = {
  'GHSA-vcc3-ghjq-m6fr': {
    since: '2026-09-03',
    module: 'decode-uri-component',
    needs: '>=0.4.3',
    why:
      "Inside Expo's own dependency tree, via query-string. Forcing a version in there to " +
      'quiet an audit is how a working mobile build stops working. Not in the app bundle.',
  },
  'GHSA-w5hq-g745-h8pq': {
    since: '2026-09-03',
    module: 'uuid',
    needs: '>=11.1.1',
    why:
      'Reached through xcode@3.0.1, part of Expo prebuild tooling for iOS. Build-time only — ' +
      'it is never bundled, and it never runs anywhere but a build machine.',
  },
  'GHSA-68fv-2mgg-jv7q': {
    since: '2026-10-06',
    module: 'source-map-js',
    needs: '>=1.2.2 (published; lockfile has 1.2.1)',
    why:
      'Build and test tooling only: postcss (Vite build, @expo/metro-config) and css-tree under jsdom ' +
      '(vitest). Never in the app bundle, the web bundle or the server, and it only parses source maps ' +
      'we generate. Taking 1.2.2 means a lockfile change that can move the Expo runtime fingerprint, so ' +
      'it rides the next dependency-refresh PR instead of an ad-hoc bump.',
  },
  'GHSA-vfj7-8cjw-p6xm': {
    since: '2026-10-03',
    module: 'braces',
    needs: '>3.0.3 (none published yet; 3.0.3 is latest)',
    why:
      'Only through Metro (metro-file-map → micromatch), the React Native bundler: build and dev time, ' +
      'with glob patterns it writes itself. Never in the app bundle, the web or the server.',
  },
  'GHSA-86w9-cpqp-85rv': {
    since: '2026-10-02',
    module: 'node-forge',
    needs: '>1.4.0 (none published yet; 1.4.0 is latest)',
    why:
      'Only through @expo/cli (the dev server / build CLI), never the app bundle or the web. ' +
      'No fixed release exists to move to; overriding inside Expo is how a mobile build breaks.',
  },
}

/**
 * Every resolved package in the lockfile, as `{ name: [versions] }`.
 *
 * Scans lines rather than parsing YAML, which is the same choice
 * `scripts/catalogBump.mjs` and `scripts/check-node-version.mjs` made, and for
 * the same reason: there is no YAML parser in this workspace, the root
 * package.json has no dependencies at all, and adding one to read four
 * thousand machine-generated lines is a poor trade.
 *
 * What it relies on is narrow and checked by the tests: inside the top-level
 * `packages:` block, every entry is a two-space-indented `name@version:` key,
 * optionally quoted. Peer suffixes like `(react@19.2.3)` appear in `snapshots:`,
 * never here — verified across the whole lockfile, 1038 entries, zero
 * exceptions. If that ever stops being true the extraction yields nothing and
 * the caller reports COULD NOT CHECK, which is the safe direction to fail in.
 */
export function readInstalled(lockText) {
  const installed = {}
  let inPackages = false

  for (const line of lockText.split('\n')) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue }
    // Any other top-level key ends the block.
    if (inPackages && /^[^\s#]/.test(line)) break
    if (!inPackages) continue

    const m = /^ {2}'?((?:@[^/'\s]+\/)?[^@'\s][^@'\s]*)@([^':\s]+)'?:\s*$/.exec(line)
    if (!m) continue
    const [, name, version] = m
    ;(installed[name] ??= []).push(version)
  }

  for (const name of Object.keys(installed)) {
    installed[name] = [...new Set(installed[name])]
  }
  return installed
}

/** `https://github.com/advisories/GHSA-x` → `GHSA-x`. The bulk endpoint gives
 *  the URL and not the id, and the id is what `KNOWN` is keyed by. */
export function advisoryId(url) {
  const m = /\/(GHSA-[0-9a-z-]+)\/?$/i.exec(url ?? '')
  return m ? m[1] : null
}

export function chunk(entries, size) {
  const out = []
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size))
  return out
}

/**
 * Ask the registry which of these are vulnerable.
 *
 * The endpoint filters by version itself — `{"uuid":["7.0.3"]}` comes back with
 * the advisory, `{"uuid":["11.1.1"]}` comes back `{}` — so there is no semver
 * matching to do here and none to get wrong.
 *
 * `fetchImpl` and `sleep` are injectable for the tests; nothing else needs them.
 */
export async function fetchAdvisories(installed, { fetchImpl = fetch, retries = 1, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const names = Object.keys(installed)
  if (names.length === 0) {
    throw new LookupFailed('no packages found in pnpm-lock.yaml — the lockfile is empty or its format moved')
  }

  const found = []
  for (const batch of chunk(names, BATCH_SIZE)) {
    const body = {}
    for (const name of batch) body[name] = installed[name]

    let lastError = null
    let answered = false
    for (let attempt = 0; attempt <= retries && !answered; attempt++) {
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), timeoutMs)
      try {
        const res = await fetchImpl(REGISTRY_BULK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: abort.signal,
        })
        if (!res.ok) throw new Error(`registry answered ${res.status} ${res.statusText}`)
        const payload = await res.json()
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('registry answered with something that is not an advisory map')
        }
        for (const [module, list] of Object.entries(payload)) {
          for (const a of list ?? []) found.push({ ...a, module_name: module, id: advisoryId(a.url) })
        }
        answered = true
      } catch (e) {
        lastError = e
      } finally {
        clearTimeout(timer)
      }
    }
    if (!answered) {
      throw new LookupFailed(`could not reach the advisory registry: ${lastError?.message ?? 'unknown error'}`)
    }
  }
  return found
}

/**
 * Sort what was found into the three buckets the exit code is built from.
 *
 * Deliberately has no opinion about *why* a lookup might be empty. The old code
 * did: it decided that every known advisory vanishing at once meant the tool was
 * broken, and exited **zero** on that. The reasoning was right and the
 * conclusion was backwards — a lookup that cannot be trusted is exactly when a
 * check must say "could not check" rather than "clean". That judgement now lives
 * in `fetchAdvisories`, where a failure is a thrown `LookupFailed` and never a
 * quiet pass.
 */
export function classify(found, known = KNOWN) {
  const seen = new Set()
  const unknown = []
  for (const a of found) {
    if (!a.id) { unknown.push(a); continue }
    seen.add(a.id)
    if (!known[a.id]) unknown.push(a)
  }
  const stale = Object.keys(known).filter((id) => !seen.has(id))
  return { found, unknown, stale }
}

function summary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    appendFileSync(path, `${lines.join('\n')}\n`)
  } catch { /* a summary is a courtesy, never the check */ }
}

/** COULD NOT CHECK. Its own exit path, its own words, on purpose: this is the
 *  outcome that spent a day looking like a finding. */
function cannotCheck(reason) {
  console.error('COULD NOT CHECK for advisories — this is not a verdict about the dependency tree.\n')
  console.error(`  ${reason}\n`)
  console.error('Nothing here says the tree is safe or unsafe. Re-run; if it persists, the registry')
  console.error('or the lockfile format moved, and scripts/check-advisories.mjs needs a look —')
  console.error('not KNOWN, and not the dependencies.')
  summary(['### Advisories: COULD NOT CHECK', '', `\`${reason}\``, '', 'This is not a verdict about the dependency tree.'])
  process.exit(1)
}

async function main() {
  let installed
  try {
    installed = readInstalled(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'))
  } catch (e) {
    cannotCheck(`could not read pnpm-lock.yaml: ${e.message}`)
  }

  let found
  try {
    found = await fetchAdvisories(installed)
  } catch (e) {
    if (e instanceof LookupFailed) cannotCheck(e.message)
    throw e
  }

  const { unknown, stale } = classify(found)
  let strays
  try {
    strays = strayLockfiles()
  } catch (e) {
    if (e instanceof LookupFailed) cannotCheck(e.message)
    throw e
  }

  if (unknown.length || stale.length || strays.length) {
    console.error('Advisory check failed:\n')
    for (const path of strays) {
      console.error(`  • ${path} is a second lockfile.`)
      console.error('    This check reads the root one, so anything pinned here is invisible to it')
      console.error('    while still being visible to every scanner that reads the repository.')
      console.error('    Delete it — workspace members resolve through the root lockfile.\n')
    }
    for (const a of unknown) {
      console.error(`  • ${String(a.severity).toUpperCase()} ${a.module_name} ${a.vulnerable_versions} — ${a.id ?? a.url}`)
      console.error(`    ${a.title}`)
      console.error(`    ${a.url}`)
      console.error('    Fix it, or add it to KNOWN in scripts/check-advisories.mjs with the reason.\n')
    }
    for (const id of stale) {
      console.error(`  • ${id} (${KNOWN[id].module}) is listed as known but no longer reported.`)
      console.error('    It was fixed or the dependency is gone — delete the entry.\n')
    }
    summary(['### Advisories: failed', '', `${unknown.length} unlisted, ${stale.length} stale, ${strays.length} stray lockfile(s).`])
    process.exit(1)
  }

  console.log(`No unlisted advisories. ${found.length} known and accounted for:`)
  for (const a of found) {
    console.log(`  ${String(a.severity).padEnd(8)} ${a.module_name} — ${a.id}, known since ${KNOWN[a.id].since}`)
  }
}

// Importable for the tests without running the check.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
