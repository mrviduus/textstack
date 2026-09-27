#!/usr/bin/env node
//
// One line in the job summary saying how far behind we are. Never fails, never
// blocks a merge: it is a gauge, not a gate.
//
// It exists because the bump lanes run twice a year now (deps-refresh.yml), and
// a calendar that quiet needs something in between it — otherwise the first
// signal that a minor has become a major is the January pull request that
// nobody can review. Security does NOT depend on this: advisories open their
// own pull requests the day they land (Dependabot security updates).
//
// Runs inside jobs that have already installed what it needs — the `frontend`
// job has the workspace, `backend` has the restore, `mobile` has the app. That
// is the whole reason it takes a mode argument instead of being its own job.
//
// Run: node scripts/report-drift.mjs <js|nuget|mobile>

import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jump } from './catalogBump.mjs'
import { latestVersions } from './nugetBump.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ponytail: hardcoded because Google publishes this as prose, not as an API.
// One number and one date, updated once a year when Play announces the next
// target — the line below turns red on its own if the date passes.
const PLAY = { requiredTargetSdk: 36, nextDeadline: '2027-08-31', nextTargetSdk: 37 }

const say = (line) => {
  console.log(line)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n')
}

// Both package managers exit non-zero when something is outdated, which is the
// normal case. Anything thrown here is reported and swallowed — a gauge that
// breaks a build is worse than no gauge.
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    return e.stdout?.toString() ?? ''
  }
}

const json = (text) => {
  const start = text.indexOf('{')
  return start === -1 ? null : JSON.parse(text.slice(start))
}

/** `{ name: latest }` + declared → "N behind — a patch/minor, b major". */
const tally = (entries) => {
  let small = 0, major = 0
  for (const [from, to] of entries) {
    const kind = jump(from, to)
    if (kind === 'major') major++
    else if (kind) small++
  }
  return { small, major, total: small + major }
}

const line = (label, { small, major, total }) =>
  total === 0
    ? `**Drift (${label}):** current`
    : `**Drift (${label}):** ${total} behind — ${small} patch/minor, ${major} major`

const modes = {
  js() {
    const out = json(run('pnpm', ['outdated', '-r', '--format', 'json']))
    if (!out) return say('**Drift (JS):** unavailable (pnpm outdated produced no JSON)')
    const entries = Object.values(out)
      .filter((p) => p?.current && p?.latest)
      .map((p) => [p.current, p.latest])
    say(line('JS', tally(entries)))
  },

  nuget() {
    const out = json(run('dotnet', ['list', 'package', '--outdated', '--format', 'json']))
    if (!out) return say('**Drift (NuGet):** unavailable (dotnet list package produced no JSON)')
    const latest = latestVersions(out)
    const props = readFileSync(join(ROOT, 'Directory.Packages.props'), 'utf8')
    const entries = []
    for (const [, name, declared] of props.matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) {
      if (latest[name]) entries.push([declared, latest[name]])
    }
    say(line('NuGet', tally(entries)))
  },

  // The one drift with a deadline attached. Expo and React Native are excluded
  // from every bump lane (they decide the OTA runtime fingerprint), so this
  // line is the only thing that will mention them until a human does.
  mobile() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'apps/mobile/package.json'), 'utf8'))
    const declared = pkg.dependencies?.expo ?? 'unknown'
    const latest = run('npm', ['view', 'expo', 'version']).trim() || 'unknown'
    say(`**Mobile:** expo ${declared} · latest published ${latest} — both lanes leave these alone by design`)

    const app = JSON.parse(readFileSync(join(ROOT, 'apps/mobile/app.json'), 'utf8'))
    const target = JSON.stringify(app).match(/"targetSdkVersion":\s*(\d+)/)?.[1]
    const overdue = Number(target) < PLAY.requiredTargetSdk
    const past = new Date() > new Date(PLAY.nextDeadline)
    const verdict = overdue
      ? `**below Play's required ${PLAY.requiredTargetSdk} — new releases are rejected**`
      : past
        ? `**${PLAY.nextTargetSdk} was required on ${PLAY.nextDeadline} — update PLAY in scripts/report-drift.mjs and the app**`
        : `meets Play's required ${PLAY.requiredTargetSdk}; ${PLAY.nextTargetSdk} due ${PLAY.nextDeadline}`
    say(`**Play target API:** targetSdkVersion ${target ?? '?'} — ${verdict}`)
  },
}

const mode = process.argv[2]
if (!modes[mode]) {
  console.error(`usage: node scripts/report-drift.mjs <${Object.keys(modes).join('|')}>`)
  process.exit(1)
}
try {
  modes[mode]()
} catch (e) {
  say(`**Drift (${mode}):** unavailable — ${e.message}`)
}
