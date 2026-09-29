#!/usr/bin/env node
//
// `npx expo install --check`, minus the part that fights the upgrade policy.
//
// The check exists because Dependabot once proposed react-native 0.87 against an SDK that expects
// 0.83, and every other job stayed green: tsc does not know what an SDK compatibility matrix is.
// That job — catching parts that were never tested together — is a minor/major question.
//
// But Expo ships patch releases constantly, and `--check` fails on those too. On 2026-09-29 every
// pull request went red because expo 57.0.26 appeared overnight, on code nobody had touched. The
// fix it asks for is a patch bump of expo-updates and expo-router, which moves the native runtime
// fingerprint: every installed app stops receiving OTA updates until a new store build ships. And
// the policy (deps-refresh.yml, docs/changelog-archive/2026-H2.md "one proposal twice a year") is
// that Expo moves on a planned native release, never because a patch appeared.
//
// So, three outcomes:
//   • aligned, or behind by patch only    → exit 0 (patch lag is a ::warning, not a failure)
//   • any package off by minor or major   → exit 1 — the case the check exists for
//   • output we cannot read               → exit 1, and says it could not check
//
// The last one matters: a failure we don't understand must never be waved through as "only patches".

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// "  expo-router@57.0.23 - expected version: ~57.0.24" (also scoped names: "@expo/ui@57.0.20 - …")
const MISMATCH = /^\s*(@?[^@\s]+)@(\d+)\.(\d+)\.(\d+)\S*\s+-\s+expected version:\s*[~^]?(\d+)\.(\d+)\.(\d+)/

/** Parse `expo install --check` output into mismatches; `null` when a line looks like one but won't parse. */
export function parseMismatches(output) {
  const mismatches = []
  for (const line of output.split('\n')) {
    if (!line.includes(' - expected version:')) continue
    const m = MISMATCH.exec(line)
    if (!m) return null
    const [, name, maj, min, , eMaj, eMin] = m
    mismatches.push({
      name,
      installed: m.slice(2, 5).join('.'),
      expected: m.slice(5, 8).join('.'),
      patchOnly: maj === eMaj && min === eMin,
    })
  }
  return mismatches
}

/** Decide from the check's exit status and output. */
export function classify(status, output) {
  if (status === 0) return { outcome: 'aligned', mismatches: [] }
  const mismatches = parseMismatches(output)
  if (mismatches === null || mismatches.length === 0) return { outcome: 'unreadable', mismatches: [] }
  return mismatches.every(x => x.patchOnly)
    ? { outcome: 'patch-lag', mismatches }
    : { outcome: 'drift', mismatches }
}

function main() {
  const run = spawnSync('npx', ['expo', 'install', '--check'], { encoding: 'utf8', cwd: process.cwd() })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const { outcome, mismatches } = classify(run.status, output)

  if (outcome === 'aligned') {
    console.log('Expo SDK: all packages aligned.')
    return
  }
  if (outcome === 'unreadable') {
    console.error(output)
    console.error('COULD NOT CHECK: `expo install --check` failed and its output was not a list of version mismatches.')
    process.exit(1)
  }
  for (const x of mismatches) {
    const line = `${x.name} ${x.installed} → expected ${x.expected}`
    if (x.patchOnly) console.log(`::warning title=Expo patch lag::${line} (patch only — moves with the next planned native release)`)
    else console.error(`  ✗ ${line}`)
  }
  if (outcome === 'drift') {
    console.error('\nExpo SDK misaligned beyond patch level — these packages were not tested together.')
    process.exit(1)
  }
  console.log(`Expo SDK: ${mismatches.length} package(s) behind by patch only — not failing (see header).`)
}

// Importable for the tests without running the check.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
