// @vitest-environment node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertBuildSurvived,
  carryForwardFailedPages,
  countRenderedPages,
  createPool,
  isProgress,
  jobLimits,
  readResults,
  reportOncePerOutage,
  superviseChild,
  survivalFloor,
} from './ssgJob.mjs'
import { NOINDEX_SKIP } from './ssgRender.mjs'

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ssg-job-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function page(dir, route, html = '<html><h1>page</h1></html>') {
  mkdirSync(join(dir, route), { recursive: true })
  writeFileSync(join(dir, route, 'index.html'), html)
}

describe('survivalFloor / assertBuildSurvived', () => {
  // floor(n * 0.9) is 0 for n = 1, so a one-route build with nothing on disk was promoted.
  it('survivalFloor_AnyRouteCount_AtLeastOnePageAndAtMostAllOfThem', () => {
    expect(survivalFloor(0)).toBe(0)
    for (let n = 1; n <= 5000; n++) {
      const floor = survivalFloor(n)
      expect(floor, `n=${n}`).toBeGreaterThanOrEqual(1)
      expect(floor, `n=${n}`).toBeLessThanOrEqual(n)
      expect(floor, `n=${n}`).toBeGreaterThanOrEqual(Math.floor(n * 0.9))
    }
    expect(survivalFloor(1)).toBe(1)
    expect(survivalFloor(10)).toBe(9)
    expect(survivalFloor(1992)).toBe(1792)
  })

  it('assertBuildSurvived_OneRouteNothingOnDisk_Throws', () => {
    expect(() => assertBuildSurvived(join(root, 'ssg-new'), 1)).toThrow(/Refusing atomic swap/)
  })

  it('assertBuildSurvived_EnoughPages_DoesNotThrow', () => {
    for (let i = 0; i < 9; i++) page(root, `/en/books/b${i}`)
    expect(() => assertBuildSurvived(root, 10)).not.toThrow()
    expect(() => assertBuildSurvived(root, 12)).toThrow(/holds 9 pages, expected at least 10 of 12/)
  })

  // "Real files": an empty index.html, or a directory with that name, is not a page.
  it('countRenderedPages_EmptyFileOrDirectoryNamedIndexHtml_NotCounted', () => {
    page(root, '/en/real')
    page(root, '/en/empty', '')
    mkdirSync(join(root, 'en', 'dir', 'index.html'), { recursive: true })
    expect(countRenderedPages(root)).toBe(1)
  })
})

describe('carryForwardFailedPages', () => {
  // The worker builds into ssg-new and swaps the whole tree, so a route that failed this time would
  // vanish from the live site. Its previous page is carried into the new tree instead.
  it('carryForwardFailedPages_FailedRouteWithLivePage_CopiedIntoNewBuild', () => {
    const live = join(root, 'ssg')
    const next = join(root, 'ssg-new')
    page(live, '/en/books/dracula', '<html>old dracula</html>')
    page(live, '/en/books/emma', '<html>old emma</html>')
    page(live, '/en/books/draft', '<html>old draft</html>')
    page(next, '/en/books/emma', '<html>new emma</html>')

    const carried = carryForwardFailedPages(
      [
        { route: '/en/books/dracula', success: false, error: 'prerender failed for /en/books/dracula: API HTTP 500 /api/en/books/dracula' },
        { route: '/en/books/emma', success: true },
        { route: '/en/books/draft', success: false, error: NOINDEX_SKIP },
        { route: '/en/books/new', success: false, error: 'timeout' },
      ],
      live,
      next,
    )

    expect(carried).toEqual(['/en/books/dracula'])
    expect(readFileSync(join(next, 'en/books/dracula/index.html'), 'utf8')).toBe('<html>old dracula</html>')
    expect(readFileSync(join(next, 'en/books/emma/index.html'), 'utf8')).toBe('<html>new emma</html>')
    // noindex is deliberate: the page is gone from the index, so its old copy is not kept.
    expect(existsSync(join(next, 'en/books/draft/index.html'))).toBe(false)
    expect(existsSync(join(next, 'en/books/new/index.html'))).toBe(false)
  })

  it('carryForwardFailedPages_RouteOutsideTheTree_Ignored', () => {
    const live = join(root, 'ssg')
    const next = join(root, 'ssg-new')
    page(root, '/secret')
    expect(carryForwardFailedPages([{ route: '/../secret', success: false, error: 'x' }], live, next)).toEqual([])
    expect(existsSync(next)).toBe(false)
  })

  it('readResults_MissingOrNotAList_Throws', () => {
    expect(() => readResults(join(root, 'nope.json'))).toThrow(/results/)
    writeFileSync(join(root, 'r.json'), '{"routes":[]}')
    expect(() => readResults(join(root, 'r.json'))).toThrow(/results/)
    writeFileSync(join(root, 'r.json'), '[{"route":"/en/","success":true}]')
    expect(readResults(join(root, 'r.json'))).toEqual([{ route: '/en/', success: true }])
  })
})

describe('superviseChild', () => {
  const node = (code) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })

  /** Every stdout chunk counts as progress, as a route result does in the worker. */
  function supervise(child, limits) {
    const supervisor = superviseChild(child, { graceMs: 5000, ...limits })
    child.stdout.on('data', () => supervisor.progress())
    return supervisor.exited
  }

  it('superviseChild_ChildExits_ReturnsItsCode', async () => {
    const result = await supervise(node('process.exit(3)'), { stallMs: 5000, deadlineMs: 5000 })
    expect(result).toMatchObject({ code: 3, stopped: null })
  })

  // The fixed deadline stopped a build that was still moving (a slow API, a bigger library). A child
  // that keeps reporting runs past the stall window as long as it likes, up to the cap.
  it('superviseChild_ChildKeepsProgressing_RunsPastTheStallWindow', async () => {
    const started = Date.now()
    const child = node('let n = 0; const t = setInterval(() => { console.log(n); if (++n === 12) { clearInterval(t) } }, 100)')
    const result = await supervise(child, { stallMs: 400, deadlineMs: 10_000 })
    expect(result).toMatchObject({ code: 0, stopped: null })
    expect(Date.now() - started).toBeGreaterThan(1000)
  })

  it('superviseChild_ChildGoesSilent_StoppedAsStalled', async () => {
    const started = Date.now()
    const child = node("console.log('started'); setInterval(() => {}, 1000)")
    const result = await supervise(child, { stallMs: 400, deadlineMs: 10_000 })
    expect(result.stopped).toBe('stalled')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('superviseChild_ChildProgressesPastTheCap_StoppedAtTheDeadline', async () => {
    const child = node('setInterval(() => console.log(1), 50)')
    const result = await supervise(child, { stallMs: 400, deadlineMs: 800 })
    expect(result.stopped).toBe('deadline')
  })

  // SIGINT first, so puppeteer can kill Chrome's process group; SIGKILL if that does not end it.
  it('superviseChild_ChildIgnoresSigint_KilledAfterGrace', async () => {
    const started = Date.now()
    const child = node("process.on('SIGINT', () => {}); setInterval(() => {}, 1000); console.log('ready')")
    await new Promise((r) => child.stdout.once('data', r))
    const result = await superviseChild(child, { stallMs: 200, deadlineMs: 10_000, graceMs: 300 }).exited
    expect(result).toMatchObject({ stopped: 'stalled', signal: 'SIGKILL' })
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('jobLimits / isProgress', () => {
  it('jobLimits_Defaults_FiveMinuteStallAndCapScaledByRoutes', () => {
    expect(jobLimits(100, {})).toEqual({ stallMs: 5 * 60_000, deadlineMs: 60 * 60_000 })
    expect(jobLimits(4000, {})).toEqual({ stallMs: 5 * 60_000, deadlineMs: 4000 * 2000 })
  })

  it('jobLimits_EnvOverrides_UsedWhenPositive', () => {
    expect(jobLimits(4000, { SSG_JOB_STALL_MS: '60000', SSG_JOB_DEADLINE_MS: '90000' })).toEqual({ stallMs: 60_000, deadlineMs: 90_000 })
    // setTimeout reads NaN as 1 ms, which would stop every job at once.
    for (const bad of ['', '0', '-5', 'abc']) {
      expect(jobLimits(100, { SSG_JOB_STALL_MS: bad, SSG_JOB_DEADLINE_MS: bad })).toEqual({ stallMs: 5 * 60_000, deadlineMs: 60 * 60_000 })
    }
  })

  // A hung API still completes every route — as a failure, at the 30 s navigation timeout — so
  // counting failures would keep a hung job alive to the cap. A retry pass is all failures by
  // construction, so there every attempt counts, or a few persistently broken routes would stall a
  // good build.
  it('isProgress_RenderedOrSkippedOrAnyRetry_CountsFirstPassFailureDoesNot', () => {
    expect(isProgress({ event: 'result', success: true })).toBe(true)
    expect(isProgress({ event: 'result', success: false, error: NOINDEX_SKIP })).toBe(true)
    expect(isProgress({ event: 'result', success: false, error: 'Navigation timeout of 30000 ms exceeded' })).toBe(false)
    expect(isProgress({ event: 'result', success: false, error: 'x', retry: 1 })).toBe(true)
    expect(isProgress({ event: 'progress', rendered: 1, failed: 0, total: 2 })).toBe(false)
  })
})

describe('createPool / reportOncePerOutage', () => {
  // pg emits 'error' on the pool when an idle client's connection dies (a database restart). With no
  // listener, EventEmitter throws it, and the worker crashed.
  it('createPool_IdleClientError_HandedToListenerNotThrown', async () => {
    const seen = []
    const pool = createPool('postgres://u:p@127.0.0.1:1/db', (err) => seen.push(err.message))
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow()
    expect(seen).toEqual(['terminating connection due to administrator command'])
    await pool.end()
  })

  it('reportOncePerOutage_SameErrorRepeated_ReportedOnceUntilRecovered', () => {
    const reported = []
    const outage = reportOncePerOutage((e) => reported.push(String(e)))
    outage.report(new Error('db down'))
    outage.report(new Error('db down'))
    outage.report(new Error('column missing'))
    outage.recovered()
    outage.report(new Error('db down'))
    expect(reported).toEqual(['Error: db down', 'Error: column missing', 'Error: db down'])
  })
})
