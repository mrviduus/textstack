#!/usr/bin/env node
//
// One Node version, declared in .nvmrc, agreed everywhere else.
//
// Written because it was not. Seven declarations carried four different
// answers: Node 20 in three CI jobs and two Dockerfiles, 22 in two more
// Dockerfiles and the EAS workflows, 24 on the developer's machine, and
// whatever the deploy server happened to have. Node 20 reached end of life on
// 2026-04-30, so the always-running ssg-worker container was serving
// production on an unsupported runtime that no longer receives security
// patches — and nothing anywhere would have said so.
//
// It surfaced by accident: eas-cli 23 requires Node >= 22, an EAS workflow was
// pinned to 20, and the install failed. A dependency's engine field was doing
// the job this check now does on purpose.
//
// Run: node scripts/check-node-version.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** The single source. Everything below is checked against it.
 *
 *  A full version, not a bare major, and that is not a preference. The deploy
 *  runner resolves Node with asdf, whose legacy-file support reads `.nvmrc`
 *  literally: a file saying `24` fails with "No preset version installed for
 *  command node" even with 24.20.0 installed. Verified on the runner. An exact
 *  version also means CI, both images and the server build on the same Node
 *  rather than on whatever each resolved `24` to that week. */
const expected = read('.nvmrc').trim()
if (!/^\d+\.\d+\.\d+$/.test(expected)) {
  console.error(`.nvmrc should hold an exact version like 24.20.0, got "${expected}"`)
  process.exit(1)
}

const problems = []
let checked = 0

// Workflows: `node-version-file: .nvmrc` is the only accepted form. A literal
// `node-version:` is what drifts, so it fails even when it happens to agree —
// agreeing today is not the property being protected.
for (const file of readdirSync(join(ROOT, '.github/workflows'))) {
  if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
  const path = `.github/workflows/${file}`
  read(path).split('\n').forEach((line, i) => {
    const literal = line.match(/^\s*node-version:\s*['"]?(\d[\w.]*)['"]?\s*$/)
    if (literal) {
      problems.push(`${path}:${i + 1} pins node-version: ${literal[1]} — use "node-version-file: .nvmrc"`)
    }
    if (/^\s*node-version-file:/.test(line)) {
      checked++
      if (!line.includes('.nvmrc')) {
        problems.push(`${path}:${i + 1} reads a version file that is not .nvmrc`)
      }
    }
  })
}

// Dockerfiles cannot read .nvmrc, so every `FROM node:<version>` has to agree.
// A literal tag, not an ARG: the base is pinned by digest (`node:X-alpine@sha256:…`),
// and with a digest present Docker ignores the tag — an ARG bump alone would leave
// the old Node in place while reading as the new one.
const dockerfiles = []
for (const dir of ['apps/web', 'apps/admin']) {
  for (const f of readdirSync(join(ROOT, dir))) {
    if (f === 'Dockerfile' || f.startsWith('Dockerfile.')) dockerfiles.push(`${dir}/${f}`)
  }
}
for (const path of dockerfiles) {
  read(path).split('\n').forEach((line, i) => {
    const from = line.match(/^FROM\s+(?:--platform=\S+\s+)?node:(\S+)/)
    if (!from) return
    checked++
    const version = from[1].match(/^(\d+(?:\.\d+)*)/)?.[1]
    if (version !== expected) {
      problems.push(`${path}:${i + 1} builds on node:${from[1]} — use "FROM node:${expected}-alpine@sha256:…"`)
    } else if (!from[1].includes('@sha256:')) {
      problems.push(`${path}:${i + 1} is not pinned by digest — use "FROM node:${expected}-alpine@sha256:…"`)
    }
  })
}

if (problems.length) {
  console.error(`Node version drift — .nvmrc says ${expected}:\n`)
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nOne version, one place. Change .nvmrc and let everything else follow.')
  process.exit(1)
}

console.log(`Node ${expected} agreed across ${checked} declarations (.nvmrc, workflows, Dockerfiles).`)
