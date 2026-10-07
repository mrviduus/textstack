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
  readResults,
  reportOncePerOutage,
  survivalFloor,
  waitForExit,
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

describe('waitForExit', () => {
  const node = (code) => spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })

  it('waitForExit_ChildExits_ReturnsItsCode', async () => {
    const result = await waitForExit(node('process.exit(3)'), { deadlineMs: 5000 })
    expect(result).toMatchObject({ code: 3, timedOut: false })
  })

  // The worker waited on prerender with no limit, so a hung render kept the job Running forever.
  it('waitForExit_ChildHangs_StoppedAtTheDeadline', async () => {
    const started = Date.now()
    const result = await waitForExit(node('setInterval(() => {}, 1000)'), { deadlineMs: 300, graceMs: 5000 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  // SIGINT first, so puppeteer can kill Chrome's process group; SIGKILL if that does not end it.
  it('waitForExit_ChildIgnoresSigint_KilledAfterGrace', async () => {
    const started = Date.now()
    const child = node("process.on('SIGINT', () => {}); setInterval(() => {}, 1000); console.log('ready')")
    await new Promise((r) => child.stdout.once('data', r))
    const result = await waitForExit(child, { deadlineMs: 200, graceMs: 300 })
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' })
    expect(Date.now() - started).toBeLessThan(3000)
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
