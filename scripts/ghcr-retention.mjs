#!/usr/bin/env node
//
// GHCR retention for the seven images.yml publishes (ghcr.io/<owner>/textstack-<svc>:<full sha>).
// Run by .github/workflows/ghcr-retention.yml; see docs/01-architecture/delivery.md.
//
// Per package, a version is KEPT if any of these holds:
//   deployed  — a tag is the SHA of one of the last DEPLOYS successful deploy.yml runs, or of
//               any deploy run (any outcome, still running too) started since the oldest of
//               them. A failed run may have stopped after `compose up`, so its SHA can be live.
//               A rollback run deploys its `rollback_commit`, not its head_sha; deploy.yml's
//               run-name carries it ("Rollback to <sha>").
//   recent    — younger than KEEP_DAYS (also covers a push still in flight)
//   newest    — among the KEEP_NEWEST newest tagged versions
//   other-tag — has a tag that is not a 40-hex commit SHA (nothing here pushes one; never ours to judge)
//   child     — referenced by the manifest index of a kept version. Deleting a platform or
//               attestation manifest of a still-tagged index breaks pulls of that tag.
// Everything else is deleted, oldest first, at most MAX_DELETE per package per run.
//
// Fails closed: any API error before the first delete (deploy runs, package listing, a
// manifest of a kept version, a rollback SHA that does not resolve) exits 1 having deleted
// nothing. Duplicate/missing deploy runs, fewer than DEPLOYS successful deploys in the
// window, or a listing that lacks the live deploy (the newest successful deploy run of the
// newest main commit that has one, looked up by head_sha) also exit 1.
//
// Env: GH_TOKEN, GITHUB_REPOSITORY, DRY_RUN (default true), KEEP_NEWEST (10), KEEP_DAYS (14),
//      DEPLOYS (5), MAX_DELETE (150), PACKAGES (space-separated service names).

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
// Runs are fetched by `created` over this window. 30 days because GitHub refuses to re-run a run
// older than that, so a re-run (which can restart an old rollback) is always inside it. Fewer than
// DEPLOYS successful deploys in it fails the run closed: a month that quiet pushed almost no
// images, so skipping the prune costs nothing, and widening the window would miss re-runs anyway.
const LOOKBACK_DAYS = 30
export const ROLLBACK_TITLE = /^Rollback to ([0-9a-f]{7,40})$/

/**
 * Pure: decide what to keep and delete for one package.
 * @param versions  GHCR versions: { id, name (digest), created_at, metadata.container.tags }
 * @param children  digests referenced by the indexes of kept tagged versions (Set)
 * @returns { keep: [{v, reasons}], del: [v] } — del ordered tagged-oldest-first, then untagged
 */
export function plan(versions, { protectedShas, children = new Set(), now, keepNewest, keepDays }) {
  const cutoff = now - keepDays * 86_400_000
  const tags = (v) => v.metadata?.container?.tags ?? []
  const byNewest = [...versions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const newest = new Set(byNewest.filter((v) => tags(v).length).slice(0, keepNewest).map((v) => v.id))

  const keep = []
  const del = []
  for (const v of byNewest) {
    const t = tags(v)
    const reasons = []
    if (t.some((x) => protectedShas.has(x))) reasons.push('deployed')
    if (Date.parse(v.created_at) >= cutoff) reasons.push('recent')
    if (newest.has(v.id)) reasons.push('newest')
    if (t.some((x) => !SHA.test(x))) reasons.push('other-tag')
    if (children.has(v.name)) reasons.push('child')
    if (reasons.length) keep.push({ v, reasons })
    else del.push(v)
  }
  // Tagged first: an index goes before its platform manifests, never the other way round.
  del.sort((a, b) => (tags(a).length ? 0 : 1) - (tags(b).length ? 0 : 1) || Date.parse(a.created_at) - Date.parse(b.created_at))
  return { keep, del }
}

/** When a run last did anything: a re-run of an old rollback restarts it now, not at `created_at`. */
export const startedAt = (r) => Date.parse(r.run_started_at ?? r.updated_at ?? r.created_at)

/** Pure: unique runs by id; throws unless they are exactly `totalCount` (page order is unstable,
 *  so a duplicate on one page can hide a run missing from the other). */
export function uniqueRuns(runs, totalCount) {
  const unique = [...new Map(runs.map((r) => [r.id, r])).values()]
  if (unique.length !== totalCount) throw new Error(`deploy runs: ${unique.length} unique of ${totalCount} — refusing to delete anything`)
  return unique
}

/** Pure: the last `deploys` successful runs, and every run (any outcome) started since the oldest
 *  of them. Fewer than `deploys` successes throws (fail closed, see LOOKBACK_DAYS). */
export function selectDeploys(runs, deploys) {
  const sorted = [...runs].sort((a, b) => startedAt(b) - startedAt(a))
  const ok = sorted.filter((r) => r.conclusion === 'success').slice(0, deploys)
  if (ok.length < deploys) throw new Error(`only ${ok.length} successful deploys in ${LOOKBACK_DAYS} days, need ${deploys} — refusing to delete anything`)
  const since = startedAt(ok[ok.length - 1])
  return { ok, later: sorted.filter((r) => startedAt(r) >= since && !ok.includes(r)) }
}

/** Pure: the newest successful run (by startedAt) of one commit's deploy runs on main, or null. */
export function newestSuccess(runs) {
  return runs.filter((r) => r.conclusion === 'success' && r.head_branch === 'main').sort((a, b) => startedAt(b) - startedAt(a))[0] ?? null
}

/** Pure: the run listing must contain the live deploy, found independently of it. Under
 *  GITHUB_TOKEN the listing has come back self-consistent (unique == total_count) yet days stale
 *  (2026-10-07: newest success 2026-10-03, 70+ newer runs missing), and nothing else catches that. */
export function checkLive(ok, live) {
  if (!live || !ok.some((r) => r.id === live.id))
    throw new Error(`live deploy ${live ? `run ${live.id} ${live.head_sha}` : '(none found)'} is not in the protected set — run listing incomplete, refusing to delete anything`)
  return live
}

/** Pure: the commit SHAs (full or short, as recorded) a set of deploy runs may have put live. */
export function deployedRefs(successRuns, sinceRuns) {
  if (!successRuns.length) throw new Error('no successful deploy.yml run found — refusing to delete anything')
  const refs = new Set()
  for (const r of [...successRuns, ...sinceRuns]) {
    const m = ROLLBACK_TITLE.exec(r.display_title ?? '')
    refs.add(m ? m[1] : r.head_sha)
  }
  return refs
}

// ---- I/O below ----

const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'

async function gh(path, method = 'GET') {
  const res = await fetch(`${api}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${await res.text()}`), { status: res.status })
  return res.status === 204 ? null : res.json()
}

async function protectedShas(repo, deploys) {
  const wf = `repos/${repo}/actions/workflows/deploy.yml/runs`
  // Every run of the last LOOKBACK_DAYS, sorted here: with GITHUB_TOKEN the API returned these
  // in no stable order (2026-10-07), so `status=success&per_page=5` is not "the last 5".
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const runs = []
  let total
  for (let page = 1; ; page++) {
    const r = await gh(`${wf}?created=${encodeURIComponent('>=' + from)}&per_page=100&page=${page}`)
    runs.push(...r.workflow_runs)
    if (r.workflow_runs.length < 100) {
      total = r.total_count
      break
    }
  }
  const { ok, later } = selectDeploys(uniqueRuns(runs, total), deploys)
  for (const r of ok) console.log(`deploy run ${r.id} ${r.run_started_at ?? r.created_at} ${r.head_sha} "${r.display_title}"`)
  // The live deploy, looked up per commit (git order, newest first), not from the listing above.
  let live = null
  for (const c of await gh(`repos/${repo}/commits?sha=main&per_page=30`)) {
    if ((live = newestSuccess((await gh(`${wf}?head_sha=${c.sha}&per_page=100`)).workflow_runs))) break
  }
  checkLive(ok, live)
  const resolve = async (ref) => (SHA.test(ref) ? ref : (await gh(`repos/${repo}/commits/${ref}`)).sha)
  const full = new Set()
  // A successful run's ref must resolve (fail closed). An unsuccessful rollback may carry a
  // typo the guard job rejected — it deployed nothing, so skip it rather than block retention.
  for (const ref of deployedRefs(ok, [])) full.add(await resolve(ref))
  for (const ref of deployedRefs(ok, later)) {
    if (full.has(ref)) continue
    try {
      full.add(await resolve(ref))
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e
      console.log(`::warning::skipping unresolvable ref ${ref} from an unsuccessful deploy run: ${e.message}`)
    }
  }
  return { full, live: await resolve([...deployedRefs([live], [])][0]) }
}

async function listVersions(owner, pkg) {
  const all = []
  for (let page = 1; ; page++) {
    const batch = await gh(`users/${owner}/packages/container/${pkg}/versions?per_page=100&page=${page}`)
    all.push(...batch)
    // Page order is not guaranteed stable (see protectedShas); a version seen twice is listed once.
    if (batch.length < 100) return [...new Map(all.map((v) => [v.id, v])).values()]
  }
}

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

/** Digests a kept version's manifest references (its platform/attestation manifests if an index). */
async function manifestChildren(owner, pkg, digest, token) {
  const res = await fetch(`https://ghcr.io/v2/${owner}/${pkg}/manifests/${digest}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_TYPES },
  })
  if (!res.ok) throw new Error(`manifest ${pkg}@${digest}: ${res.status}`)
  return ((await res.json()).manifests ?? []).map((m) => m.digest)
}

async function registryToken(owner, pkg) {
  const basic = Buffer.from(`x:${process.env.GH_TOKEN}`).toString('base64')
  const res = await fetch(`https://ghcr.io/token?scope=repository:${owner}/${pkg}:pull`, { headers: { Authorization: `Basic ${basic}` } })
  if (!res.ok) throw new Error(`ghcr token for ${pkg}: ${res.status}`)
  return (await res.json()).token
}

async function main() {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY
  const owner = repo.split('/')[0]
  const dryRun = env.DRY_RUN !== 'false'
  const keepNewest = Math.max(5, Number(env.KEEP_NEWEST ?? 10))
  const keepDays = Math.max(1, Number(env.KEEP_DAYS ?? 14))
  const maxDelete = Math.max(0, Number(env.MAX_DELETE ?? 150))
  const packages = (env.PACKAGES ?? 'api worker admin ssg-worker migrator mcp-server web').split(/\s+/).filter(Boolean)
  if (!Number.isFinite(keepNewest) || !Number.isFinite(keepDays) || !Number.isFinite(maxDelete)) throw new Error('KEEP_NEWEST, KEEP_DAYS and MAX_DELETE must be numbers')

  const { full: shas, live } = await protectedShas(repo, Math.max(1, Number(env.DEPLOYS ?? 5)))
  console.log(`Live (latest successful deploy): ${live}`)
  console.log(`Protected SHAs (${shas.size}): ${[...shas].join(' ')}`)
  console.log(`keep newest ${keepNewest}, younger than ${keepDays}d; max ${maxDelete} deletions per package; ${dryRun ? 'DRY RUN' : 'DELETING'}\n`)

  // Plan everything before deleting anything: any listing or manifest failure aborts with nothing deleted.
  const plans = []
  const now = Date.now()
  for (const svc of packages) {
    const pkg = `textstack-${svc}`
    let versions
    try {
      versions = await listVersions(owner, pkg)
    } catch (e) {
      // A package added to PACKAGES before its first push (textstack-web, 2026-10-07) has
      // nothing to prune. Skipping it deletes nothing anywhere; any other error still aborts.
      if (e.status !== 404) throw e
      console.log(`::warning::${pkg}: not found (404) — not published yet? Nothing to prune`)
      continue
    }
    const opts = { protectedShas: shas, now, keepNewest, keepDays }
    const first = plan(versions, opts)
    const children = new Set()
    if (first.del.some((v) => !v.metadata?.container?.tags?.length)) {
      const token = await registryToken(owner, pkg)
      for (const { v } of first.keep) {
        if (v.metadata?.container?.tags?.length) for (const d of await manifestChildren(owner, pkg, v.name, token)) children.add(d)
      }
    }
    const p = plan(versions, { ...opts, children })
    if (!versions.some((v) => v.metadata?.container?.tags?.includes(live)))
      console.log(`::warning::${pkg} has no version tagged ${live} (server-built deploy?)`)
    plans.push({ pkg, versions, ...p })
  }

  const summary = ['| package | versions | keep | delete | deferred (cap) |', '|---|---|---|---|---|']
  for (const { pkg, versions, keep, del } of plans) {
    const batch = del.slice(0, maxDelete)
    console.log(`== ${pkg}: ${versions.length} versions, keep ${keep.length}, delete ${batch.length}${del.length > batch.length ? `, deferred ${del.length - batch.length}` : ''}`)
    for (const { v, reasons } of keep) console.log(`   keep ${v.id} ${(v.metadata?.container?.tags ?? []).join(',') || '<untagged>'} ${v.created_at} [${reasons.join(',')}]`)
    for (const v of batch) {
      const label = (v.metadata?.container?.tags ?? []).join(',') || `<untagged> ${v.name}`
      if (!dryRun) await gh(`users/${owner}/packages/container/${pkg}/versions/${v.id}`, 'DELETE')
      console.log(`   ${dryRun ? 'would delete' : 'deleted'} ${v.id} ${label} ${v.created_at}`)
    }
    summary.push(`| ${pkg} | ${versions.length} | ${keep.length} | ${batch.length} | ${del.length - batch.length} |`)
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### GHCR retention${dryRun ? ' (dry run)' : ''}\n\n${summary.join('\n')}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`::error::${e.message}`)
    process.exit(1)
  })
}
