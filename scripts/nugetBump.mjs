// Deciding which central NuGet versions may move, and rewriting them in place.
//
// The NuGet half of scripts/catalogBump.mjs, and deliberately its mirror image:
// same judgement (patch and minor yes, major no), same reason for living apart
// from the workflow that calls it, and the same `jump()` — semver distance is
// not a thing worth implementing twice.
//
// Edits line by line rather than round-tripping the XML: Directory.Packages.props
// is more comment than data, and each comment records a resolution failure that
// cost something. An XML writer would reformat all of it away.
//
// Only top-level packages move. `dotnet list package --outdated` is called
// WITHOUT --include-transitive on purpose: the entries in that file which exist
// solely to pin a transitive (Microsoft.OpenApi, held on the 2.x line for
// compatibility with AspNetCore.OpenApi) are there because a human decided the
// number, and nothing here should out-vote that.

import { jump } from './catalogBump.mjs'

/** Packages that must carry the SAME version as each other or not move at all.
 *
 *  The MCP server pins `ModelContextProtocol.AspNetCore` to match
 *  `ModelContextProtocol` — one is the http transport for the other, they ship
 *  from one repository on one version number, and a mismatch is a protocol
 *  desync that compiles, starts, and fails on the wire. Nothing in the build
 *  catches it, which is why it is checked here rather than left to CI. */
const LOCKSTEP = [['ModelContextProtocol', 'ModelContextProtocol.AspNetCore']]

/** A `<PackageVersion Include="X" Version="Y" />` line, however indented. */
const ENTRY = /^(\s*)<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"\s*\/>\s*$/

/**
 * `dotnet list package --outdated --format json` → `{ name: latest }`.
 *
 * The same package appears once per project under central management, with the
 * same numbers each time; last write wins and they agree.
 */
export function latestVersions(json) {
  const out = {}
  for (const project of json?.projects ?? []) {
    for (const fw of project.frameworks ?? []) {
      for (const pkg of fw.topLevelPackages ?? []) {
        if (pkg.id && pkg.latestVersion) out[pkg.id] = pkg.latestVersion
      }
    }
  }
  return out
}

/**
 * @param {string} xmlText  contents of Directory.Packages.props
 * @param {Record<string, string>} latest  from latestVersions()
 * @returns {{text: string, applied: string[], skipped: string[]}}
 */
export function bumpPackages(xmlText, latest) {
  const lines = xmlText.split('\n')
  const applied = [], skipped = []

  // A group moves as one or not at all. Held here rather than mid-loop so the
  // decision is made before any line is rewritten.
  const held = new Set()
  for (const group of LOCKSTEP) {
    const targets = new Set(group.map((name) => latest[name]).filter(Boolean))
    if (targets.size > 1) {
      for (const name of group) held.add(name)
      skipped.push(`${group.join(' + ')} — must move together, offered ${[...targets].join(' vs ')}`)
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY.exec(lines[i])
    if (!m) continue
    const [, indent, name, declared] = m

    const to = latest[name]
    if (!to || held.has(name)) continue

    // A cross-package constraint can make a legal minor unbuildable — this file
    // documents an NU1109 where EF Core and Npgsql disagreed. That is what the
    // build, the tests and the migration check in CI are for; this stays a
    // proposal, never a push.
    const kind = jump(declared, to)
    if (!kind) continue
    if (kind === 'major') {
      skipped.push(`${name} ${declared} → ${to} — major`)
      continue
    }

    lines[i] = `${indent}<PackageVersion Include="${name}" Version="${to}" />`
    applied.push(`${name} ${declared} → ${to} (${kind})`)
  }

  return { text: lines.join('\n'), applied, skipped }
}

/** Markdown for the job summary and the PR body. */
export function report({ applied, skipped }) {
  const out = [applied.length ? '### NuGet raised' : '### NuGet already current', '']
  for (const a of applied) out.push(`- ${a}`)
  if (skipped.length) {
    out.push('', '### Left alone (NuGet)', '')
    for (const s of skipped) out.push(`- ${s}`)
  }
  return out.join('\n')
}
