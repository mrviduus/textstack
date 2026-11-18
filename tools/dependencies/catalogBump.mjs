// Deciding which shared versions may move, and rewriting them in place.
//
// Kept separate from the workflow that calls it because the interesting part is
// a judgement — patch and minor yes, major no, some packages never — and a
// judgement that runs once a week unattended is one you want a test for. The
// first version of this compared against the *installed* version reported by
// `pnpm outdated` while rewriting the *declared* one, which are not the same
// number and are not always the same distance from `latest`.
//
// Edits line by line rather than round-tripping the YAML: pnpm-workspace.yaml
// is more comment than data, and each comment records something that cost a
// debugging session.

/** Never moved automatically. These reach the mobile runtime, where Expo pins
 *  them against its SDK compatibility matrix and React Native declares a peer
 *  range around them. A bot bump passes CI — tsc and the unit tests do not know
 *  what an SDK matrix is — and it surfaces as a mobile build that no longer
 *  matches what is installed on phones. */
export const MANUAL_ONLY = new Set(['react', 'react-dom', '@types/react'])

const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v))
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null
}

/** How far `to` sits above `from`: 'major' | 'minor' | 'patch' | null. */
export function jump(from, to) {
  const a = parse(from), b = parse(to)
  if (!a || !b) return null
  if (b.major !== a.major) return b.major > a.major ? 'major' : null
  if (b.minor !== a.minor) return b.minor > a.minor ? 'minor' : null
  if (b.patch !== a.patch) return b.patch > a.patch ? 'patch' : null
  return null
}

/** A `name: version` line inside the catalog block, keeping quotes and range prefix. */
const ENTRY = /^(\s+)(['"]?)([^'":]+)\2:\s*(['"]?)([\^~]?)(\d[\w.-]*)\4\s*$/

/**
 * @param {string} yamlText  contents of pnpm-workspace.yaml
 * @param {Record<string, {latest?: string}>} outdated  `pnpm outdated --format json`
 * @returns {{text: string, applied: string[], skipped: string[]}}
 */
export function bumpCatalog(yamlText, outdated) {
  const lines = yamlText.split('\n')
  const applied = [], skipped = []
  // Only inside `catalog:`. A two-space `name: value` under `packages:` or
  // `allowBuilds:` looks identical and must not be touched.
  let inCatalog = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^catalog:\s*$/.test(line)) { inCatalog = true; continue }
    if (inCatalog && /^\S/.test(line)) inCatalog = false
    if (!inCatalog) continue

    const m = ENTRY.exec(line)
    if (!m) continue
    const [, indent, nq, name, vq, prefix, declared] = m

    const latest = outdated[name]?.latest
    if (!latest) continue

    // Report the declaration as written, prefix included — that is the string
    // someone will go looking for in the file.
    const written = `${prefix}${declared}`

    if (MANUAL_ONLY.has(name)) {
      skipped.push(`${name} ${written} → ${latest} — pinned to the mobile runtime, move it by hand`)
      continue
    }

    // Compare what is written here, not what happens to be installed. Those
    // differ whenever the range has floated, and it is the declaration being
    // rewritten.
    const kind = jump(declared, latest)
    if (!kind) continue
    if (kind === 'major') {
      skipped.push(`${name} ${written} → ${latest} — major`)
      continue
    }

    lines[i] = `${indent}${nq}${name}${nq}: ${vq}${prefix}${latest}${vq}`
    applied.push(`${name} ${written} → ${latest} (${kind})`)
  }

  return { text: lines.join('\n'), applied, skipped }
}

/** Markdown for the job summary and the PR body. */
export function report({ applied, skipped }) {
  const out = [applied.length ? '### Catalog raised' : '### Catalog already current', '']
  for (const a of applied) out.push(`- ${a}`)
  if (skipped.length) {
    out.push('', '### Left alone', '')
    for (const s of skipped) out.push(`- ${s}`)
  }
  return out.join('\n')
}
