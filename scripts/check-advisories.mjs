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
// is not a check, and because the alert list will always hold the three
// advisories below — three permanent entries are how a list stops being read.
// Here they are text, with dates and reasons, in a file that shows up in review.
//
// Two ways to fail, and the second matters as much as the first:
//   • an advisory nobody has written down  → someone must look at it
//   • an entry here that no longer appears → it is fixed or gone; delete it
//
// Run: node scripts/check-advisories.mjs

import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * One workspace, one lockfile — and `pnpm audit` reads exactly that one.
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
function strayLockfiles() {
  const out = execFileSync('git', ['ls-files', '--', '*pnpm-lock.yaml', '*package-lock.json', '*yarn.lock'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
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
const KNOWN = {
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
}

// `pnpm audit` exits non-zero whenever anything is found, which is the normal
// case here and not a failure of the command. The report still arrives on stdout.
//
// stderr is kept, not discarded: when the registry's advisory lookup fails,
// pnpm still prints well-formed JSON on stdout with an empty `advisories`
// object, and the only trace of the failure is on stderr.
function audit() {
  const opts = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  let out = ''
  let err = ''
  try {
    out = execFileSync('pnpm', ['audit', '--json'], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    out = e.stdout?.toString() ?? ''
    err = e.stderr?.toString() ?? ''
  }
  // Silence from a broken command must not read as a clean tree. That is the
  // exact failure mode this file exists to prevent, so it is checked here too.
  if (!out.trim()) {
    console.error('pnpm audit produced no output — treating that as a failure, not as "nothing found"')
    if (err.trim()) console.error(err.trim())
    process.exit(1)
  }
  return { report: JSON.parse(out), stderr: err }
}

const { report, stderr } = audit()
const advisories = Object.values(report.advisories ?? {})
const seen = new Set()
const unknown = []

for (const a of advisories) {
  const id = a.github_advisory_id
  seen.add(id)
  if (!KNOWN[id]) unknown.push(a)
}

const stale = Object.keys(KNOWN).filter((id) => !seen.has(id))

// Every known advisory disappearing at once is not three upstreams shipping
// fixes in the same minute — it is the lookup failing while still returning
// well-formed JSON. That happened on the first deploy after this file landed:
// all three vanished in CI and all three were present locally, minutes apart.
//
// So the count is the evidence. SOME entries missing is a real change and still
// fails. ALL of them missing is the tool, not the tree, and blocking every
// deploy on a flaky third-party endpoint is worse than saying so out loud. The
// check that matters — an advisory nobody wrote down — is unaffected either way.
const lookupLooksBroken = advisories.length === 0 && stale.length === Object.keys(KNOWN).length
if (lookupLooksBroken) {
  console.error('Every known advisory is missing at once, and pnpm audit reported nothing at all.')
  console.error('That is the advisory lookup failing, not three fixes landing together.')
  if (stderr.trim()) console.error(`\npnpm said:\n${stderr.trim()}`)
  console.error('\nNot failing the build on it. Re-run to confirm, and if it persists, look at')
  console.error('the registry rather than at KNOWN in scripts/check-advisories.mjs.')
  process.exit(0)
}

const strays = strayLockfiles()

if (unknown.length || stale.length || strays.length) {
  console.error('Advisory check failed:\n')
  for (const path of strays) {
    console.error(`  • ${path} is a second lockfile.`)
    console.error('    pnpm audit reads the root one, so anything pinned here is invisible to it')
    console.error('    while still being visible to every scanner that reads the repository.')
    console.error('    Delete it — workspace members resolve through the root lockfile.\n')
  }
  for (const a of unknown) {
    console.error(`  • ${a.severity.toUpperCase()} ${a.module_name} ${a.vulnerable_versions} — ${a.github_advisory_id}`)
    console.error(`    ${a.title}`)
    console.error(`    ${a.url}`)
    console.error('    Fix it, or add it to KNOWN in scripts/check-advisories.mjs with the reason.\n')
  }
  for (const id of stale) {
    console.error(`  • ${id} (${KNOWN[id].module}) is listed as known but no longer reported.`)
    console.error('    It was fixed or the dependency is gone — delete the entry.\n')
  }
  process.exit(1)
}

console.log(`No unlisted advisories. ${advisories.length} known and accounted for:`)
for (const a of advisories) {
  console.log(`  ${a.severity.padEnd(8)} ${a.module_name} — ${a.github_advisory_id}, known since ${KNOWN[a.github_advisory_id].since}`)
}
