#!/usr/bin/env node
//
// Say, on the pull request, when a change moves the mobile runtime fingerprint.
//
// `app.json` sets `runtimeVersion.policy: "fingerprint"`, so an OTA only reaches
// builds whose runtime matches. Move the fingerprint and the change can no
// longer ship as an update — it needs a Play build and a tester cycle.
//
// There was already a guard for this, in mobile-ota.yml, and it works: it
// refuses to publish into a runtime nobody is running. But it runs *after* the
// merge, on main. So it reports the problem to the person who can no longer
// avoid it.
//
// This is the same question asked one step earlier, while the answer still
// changes a decision. It would have flagged the pnpm workspace migration before
// it landed — that PR moved 122 of 135 fingerprint sources into the workspace
// root and stranded an OTA that had been verified working an hour before — and
// it flags every dependency bump that reaches a native module, which is exactly
// the class a bot proposes and CI otherwise waves through.
//
// Deliberately does not fail. Native changes move the fingerprint legitimately
// and often; a check that blocked them would be turned off within a week. It
// tells you which kind of change you are making, and the decision stays yours.
//
// Run: node infra/scripts/report-runtime-change.mjs <base-runtime> <head-runtime>

import { appendFileSync } from 'node:fs'

const [base, head] = process.argv.slice(2)

if (!base || !head) {
  console.error('usage: report-runtime-change.mjs <base-runtime> <head-runtime>')
  process.exit(1)
}

const moved = base !== head

const lines = moved
  ? [
      '### This change moves the mobile runtime',
      '',
      '| | |',
      '|---|---|',
      `| base | \`${base}\` |`,
      `| this branch | \`${head}\` |`,
      '',
      'It cannot reach installed apps as an OTA update. Shipping it needs',
      '**mobile-release.yml → build-submit**, and testers have to install the new build',
      'before anything else can be delivered to them by update.',
      '',
      'Something native moved: a dependency, an Expo config plugin, or app.json.',
      'That is often correct — this is not an error, just the thing worth knowing before merging.',
    ]
  : [
      '### Mobile runtime unchanged',
      '',
      `\`${head}\` — same as base, so this ships as an OTA update.`,
    ]

const text = lines.join('\n')
console.log(text)

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
if (moved) {
  // An annotation on the PR itself, so it is visible without opening the run.
  console.log(`::warning title=Mobile runtime changed::Needs a Play build, not an OTA. ${base} → ${head}`)
}
