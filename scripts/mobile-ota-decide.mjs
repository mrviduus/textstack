#!/usr/bin/env node
//
// What mobile-ota.yml does with this commit: publish an update, start a store build, or neither.
//
//   publish — the runtime matches the newest FINISHED production build: installed apps can take
//             an update. Also when an in-flight production build has this runtime (`queued`).
//   build   — the runtime matches nothing installed or on its way: start a store build. Its
//             binary carries this commit's JS, so no update is published (none could land yet).
//   queued  — the runtime differs from the installed build, but a production build with this
//             exact runtime is already NEW / IN_QUEUE / IN_PROGRESS. Without this case every push
//             between "build queued" and "build finished" saw only the old finished build and
//             started another store build (`--no-wait` ends the run long before the build does).
//             No second build; the update IS published, to that runtime: the queued binary embeds
//             an older commit, and on first launch it fetches this newer update. Skipping it would
//             strand this commit until the next mobile push.
//
// A build that ERRORED or was CANCELED blocks nothing — the next push builds again.
//
// Run: node scripts/mobile-ota-decide.mjs <eas build:list --json file> <this commit's runtime>
// Writes action, runtime, id, inflight_id, inflight_status to $GITHUB_OUTPUT. Exits 1, with a
// summary of what was searched, when no finished production build can be read.

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const IN_FLIGHT = new Set(['NEW', 'IN_QUEUE', 'IN_PROGRESS'])

const channelOf = (b) => (typeof b.updateChannel === 'object' ? b.updateChannel?.name : b.updateChannel)
const statusOf = (b) => String(b.status ?? '').toUpperCase()
const isProduction = (b) => b.buildProfile === 'production' || channelOf(b) === 'production'

// The field is `runtime`, an object `{ id, version }` in real responses; a bare string and the
// fingerprint hash (the same value under a fingerprint policy) are accepted as fallbacks.
export function runtimeOf(b) {
  const pick = (v, ...keys) => (v && typeof v === 'object' ? keys.map((k) => v[k]).find(Boolean) : v)
  return pick(b.runtime, 'version', 'runtimeVersion') || b.runtimeVersion || pick(b.fingerprint, 'hash') || ''
}

/** Pure. `builds` as `eas build:list --json` returns them, any statuses, any order. */
export function decide(builds, hash) {
  const prod = builds
    .filter(isProduction)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  const installed = prod.find((b) => statusOf(b) === 'FINISHED')
  if (!installed) return { error: 'no-build' }
  const runtime = runtimeOf(installed)
  if (!runtime) return { error: 'no-runtime', installed }
  if (runtime === hash) return { action: 'publish', installed, runtime }
  const inflight = prod.find((b) => IN_FLIGHT.has(statusOf(b)) && runtimeOf(b) === hash)
  return { action: inflight ? 'queued' : 'build', installed, runtime, inflight }
}

// "No production build exists" and "matched on the wrong field" produce identical silence
// otherwise, and the first version of this check could not tell them apart. Profiles, channels
// and key names only.
function explain(result, builds) {
  const uniq = (f) => [...new Set(builds.map((b) => f(b) ?? 'null'))].join(', ')
  if (result.error === 'no-runtime') {
    const b = result.installed
    return [
      '### Production build found, but no runtime on it', '',
      `Build \`${b.id}\`.`, '',
      `\`runtime\`: \`${JSON.stringify(b.runtime ?? 'absent')}\``, '',
      `\`fingerprint\`: \`${JSON.stringify(b.fingerprint ?? 'absent')}\``,
    ]
  }
  return [
    '### No production build to publish against', '',
    `Searched ${builds.length} Android builds (${builds.filter((b) => statusOf(b) === 'FINISHED').length} finished).`, '',
    `Build profiles seen: \`${uniq((b) => b.buildProfile)}\``, '',
    `Update channels seen: \`${uniq(channelOf)}\``, '',
    `Keys on the newest record: \`${Object.keys(builds[0] ?? {}).join(', ')}\``, '',
    'Either no production build exists yet — run **mobile-release.yml → build** —',
    'or the fields above are not the ones this check matches on.',
  ]
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, hash] = process.argv.slice(2)
  if (!file || !hash) {
    console.error('usage: mobile-ota-decide.mjs <builds.json> <runtime>')
    process.exit(2)
  }
  const builds = JSON.parse(readFileSync(file, 'utf8'))
  const r = decide(builds, hash)
  if (r.error) {
    const text = explain(r, builds).join('\n') + '\n'
    console.log(text)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
    console.log(`::error::No finished Android production build with a readable runtime (${r.error}). See the summary.`)
    process.exit(1)
  }
  const out = {
    action: r.action,
    runtime: r.runtime,
    id: r.installed.id,
    inflight_id: r.inflight?.id ?? '',
    inflight_status: r.inflight ? statusOf(r.inflight) : '',
  }
  console.log(JSON.stringify(out))
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''))
  }
}
