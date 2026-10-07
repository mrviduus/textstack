// @vitest-environment node
import { createServer, request } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import puppeteer from 'puppeteer'
import { NOINDEX_SKIP, processRoutes, renderRoute, startServer, stopServer } from './ssgRender.mjs'

/** An upstream API. `handler` decides per request; the sockets are kept so a test can see them close. */
async function fakeApi(handler) {
  const sockets = new Set()
  const server = createServer(handler)
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sockets,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}

const NEVER_ANSWERS = () => {}

function within(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still pending after ${ms} ms`)), ms)),
  ])
}

async function until(predicate, ms, what) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${what}: not true after ${ms} ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A GET through the proxy that resolves with the response and can be abandoned mid-flight. */
function get(port, path) {
  let req
  const response = new Promise((resolve, reject) => {
    req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
  response.catch(() => {})
  return { response, abandon: () => req.destroy() }
}

describe('static server + API proxy shutdown', () => {
  let api
  let server
  let dist

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'ssg-dist-'))
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>t</title>')
  })
  afterAll(() => rmSync(dist, { recursive: true, force: true }))

  afterEach(async () => {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
    await api?.close()
  })

  // The hang behind "prerender never exits": the browser gives up on a request (page closed, fetch
  // timed out) and the proxy's request to an API that never answers stays open — and keeps the
  // process alive after everything else has finished.
  it('proxy_ClientGivesUp_UpstreamRequestIsClosed', async () => {
    api = await fakeApi(NEVER_ANSWERS)
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'localhost', port: 0 })

    const call = get(server.address().port, '/api/en/books')
    await until(() => api.sockets.size === 1, 2000, 'request reached the API')
    call.abandon()

    await until(() => api.sockets.size === 0, 2000, 'upstream socket closed')
  })

  it('proxy_UpstreamNeverAnswers_504AfterTimeout', async () => {
    api = await fakeApi(NEVER_ANSWERS)
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'localhost', port: 0, upstreamTimeoutMs: 200 })

    const { status } = await within(get(server.address().port, '/api/en/books').response, 3000, 'proxied request')

    expect(status).toBe(504)
    await until(() => api.sockets.size === 0, 2000, 'upstream socket closed')
  })

  it('stopServer_RequestInFlightToHungApi_ResolvesAndClosesUpstream', async () => {
    api = await fakeApi(NEVER_ANSWERS)
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'localhost', port: 0 })

    get(server.address().port, '/api/en/books')
    await until(() => api.sockets.size === 1, 2000, 'request reached the API')

    await within(stopServer(server), 2000, 'stopServer')
    await until(() => api.sockets.size === 0, 2000, 'upstream socket closed')
  })

  it('proxy_UpstreamAnswers_PassesThrough', async () => {
    api = await fakeApi((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url, host: req.headers.host }))
    })
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'textstack.test', port: 0 })

    const { status, body } = await get(server.address().port, '/api/en/books').response

    expect(status).toBe(200)
    expect(JSON.parse(body)).toEqual({ path: '/en/books', host: 'textstack.test' })
  })

  // The proxy used to cut every URL at '?', so /authors?sort=recent&limit=12 reached the API as
  // /authors and SSG pages were rendered with the API's defaults instead of what the SPA asks for.
  it('proxy_QueryString_ReachesApiIntact', async () => {
    api = await fakeApi((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url }))
    })
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'localhost', port: 0 })
    const port = server.address().port

    const apiCall = await get(port, '/api/en/authors?sort=recent&limit=12&q=a%20b').response
    const storage = await get(port, '/storage/ab/cover.jpg?v=2').response

    expect(JSON.parse(apiCall.body)).toEqual({ path: '/en/authors?sort=recent&limit=12&q=a%20b' })
    expect(JSON.parse(storage.body)).toEqual({ path: '/storage/ab/cover.jpg?v=2' })
  })

  it('static_QueryString_StillServesTheFile', async () => {
    writeFileSync(join(dist, 'app.js'), 'ok()')
    server = await startServer({ distDir: dist, apiUrl: 'http://127.0.0.1:1', apiHost: 'localhost', port: 0 })

    const { status, body } = await get(server.address().port, '/app.js?v=1').response

    expect(status).toBe(200)
    expect(body).toBe('ok()')
  })
})

// A page shaped like the app: it fetches its data through /api/, retries once, and on failure shows
// an error state — which, like BookDetailPage's, has an <h1> and no noindex. The route names the API
// path it loads; `noindex-on-error` adds noindex to the error state, as the not-found branches do.
const APP = `<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script>
(async () => {
  const root = document.getElementById('root')
  const name = location.pathname.split('/')[1]
  const later = () => new Promise((r) => setTimeout(r, 150))
  const noindex = () => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex,follow'
    document.head.appendChild(meta)
  }
  // Like the real app on a missing book: the 404 throws before the body is read, and the browser
  // aborts the unread body — a requestfailed for the same URL, after its response.
  if (name === 'notfound-abort') {
    const ctrl = new AbortController()
    await fetch('/api/' + name, { signal: ctrl.signal })
    ctrl.abort()
    await later()
    noindex()
    root.innerHTML = '<div><h1>Not found</h1><p class="not-found">gone</p></div>'
    return
  }
  // A 503, a retry that answers 200, then the first request's unread body is aborted.
  if (name === 'retry-abort') {
    const first = new AbortController()
    await fetch('/api/' + name, { signal: first.signal })
    const res = await fetch('/api/' + name)
    const data = await res.json()
    first.abort()
    await later()
    root.innerHTML = '<main><h1>' + data.title + '</h1></main>'
    return
  }
  // No response at all: the app gives up and shows its error state.
  if (name === 'unanswered') {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 300)
    await fetch('/api/' + name, { signal: ctrl.signal }).catch(() => null)
    root.innerHTML = '<div><h1>Not available</h1><p class="error">API error</p></div>'
    return
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/' + name).catch(() => null)
    if (res && res.ok) {
      root.innerHTML = '<main><h1>' + (await res.json()).title + '</h1></main>'
      return
    }
  }
  if (name === 'noindex-on-error') {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex,follow'
    document.head.appendChild(meta)
  }
  root.innerHTML = '<div><h1>Not available</h1><p class="error">API error</p></div>'
})()
</script></body></html>`

describe('renderRoute', () => {
  let api
  let server
  let browser
  let dist
  let out
  const calls = new Map()

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'ssg-dist-'))
    writeFileSync(join(dist, 'index.html'), APP)
    api = await fakeApi((req, res) => {
      const n = (calls.get(req.url) ?? 0) + 1
      calls.set(req.url, n)
      // Status sent, body never finished: the page aborts it.
      if (req.url === '/notfound-abort' || (req.url === '/retry-abort' && n === 1)) {
        res.writeHead(req.url === '/notfound-abort' ? 404 : 503, { 'content-type': 'application/json' })
        return void res.write('{"error":')
      }
      if (req.url === '/unanswered') return
      if (req.url === '/retry-abort') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ title: 'Loaded after retry' }))
      }
      const ok = req.url === '/ok' || (req.url === '/flaky' && n > 1)
      res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { title: `Loaded ${req.url}` } : { error: 'boom' }))
    })
    server = await startServer({ distDir: dist, apiUrl: api.url, apiHost: 'localhost', port: 0 })
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    if (server) await stopServer(server)
    await api?.close()
    rmSync(dist, { recursive: true, force: true })
  })

  async function render(route) {
    out = mkdtempSync(join(tmpdir(), 'ssg-out-'))
    try {
      const result = await renderRoute(browser, route, { outputDir: out, port: server.address().port })
      return { result, saved: existsSync(join(out, route, 'index.html')) }
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }

  it('renderRoute_ApiAnswers_PageSaved', async () => {
    const { result, saved } = await render('/ok')
    expect(result).toMatchObject({ route: '/ok', success: true })
    expect(saved).toBe(true)
  }, 30_000)

  // The bug: the error state has an <h1> and no noindex, so it was saved as the page ("1/1 rendered").
  it('renderRoute_ApiReturns500_FailsAndNothingSaved', async () => {
    const { result, saved } = await render('/broken')
    expect(result.success).toBe(false)
    expect(result.error.split('\n')[0]).toBe('prerender failed for /broken: API HTTP 500 /api/broken')
    expect(saved).toBe(false)
  }, 30_000)

  // A broken API must not be mistaken for a deliberate noindex skip: the worker keeps the previous
  // page for a failed route, and drops it for a noindex one.
  it('renderRoute_ApiReturns500OnNoindexErrorState_IsAnApiFailureNotANoindexSkip', async () => {
    const { result, saved } = await render('/noindex-on-error')
    expect(result.success).toBe(false)
    expect(result.error).not.toBe(NOINDEX_SKIP)
    expect(result.error).toMatch(/^prerender failed for \/noindex-on-error: API HTTP 500/)
    expect(saved).toBe(false)
  }, 30_000)

  // The app retries; a 500 followed by a 200 for the same call is a page whose data loaded.
  it('renderRoute_ApiFailsThenRecovers_PageSaved', async () => {
    const { result, saved } = await render('/flaky')
    expect(result).toMatchObject({ success: true })
    expect(saved).toBe(true)
  }, 30_000)
  // A real 404 followed by an abort of its unread body was recorded as "no response", so a deleted
  // book counted as an API failure and its stale page was carried forward forever.
  it('renderRoute_404ThenBodyAborted_IsANoindexSkip', async () => {
    const { result, saved } = await render('/notfound-abort')
    expect(result).toMatchObject({ success: false, error: NOINDEX_SKIP })
    expect(saved).toBe(false)
  }, 30_000)

  it('renderRoute_503ThenRetry200ThenFirstBodyAborted_PageSaved', async () => {
    const { result, saved } = await render('/retry-abort')
    expect(result).toMatchObject({ success: true })
    expect(saved).toBe(true)
  }, 30_000)

  it('renderRoute_RequestNeverAnswered_IsAnApiFailure', async () => {
    const { result, saved } = await render('/unanswered')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^prerender failed for \/unanswered: API net::ERR_ABORTED \/api\/unanswered/)
    expect(saved).toBe(false)
  }, 30_000)
})

describe('processRoutes', () => {
  // A scripted renderer: each route answers with its list of outcomes, one per attempt.
  function scripted(plan) {
    const attempts = new Map()
    const render = async ({ route }) => {
      const n = attempts.get(route) ?? 0
      attempts.set(route, n + 1)
      const outcome = plan[route][Math.min(n, plan[route].length - 1)]
      return outcome === 'ok' ? { route, success: true } : { route, success: false, error: outcome }
    }
    return { render, attempts }
  }

  async function run(plan) {
    const { render, attempts } = scripted(plan)
    const events = []
    const routes = Object.keys(plan).map((route) => ({ route }))
    const results = await processRoutes(routes, render, { concurrency: 2, emit: (e) => events.push(e) })
    return { byRoute: Object.fromEntries(results.map((r) => [r.route, r])), attempts, events, results }
  }

  // The retry only replaced a failure with a success, so a route that failed (a transient 503) and was
  // a draft or gone by its retry kept the failure — and the worker carried its old page forward.
  it('processRoutes_FailsThenNoindexOnRetry_RecordedAsNoindexSkip', async () => {
    const { byRoute, attempts } = await run({ '/ok': ['ok'], '/gone': ['API HTTP 503', NOINDEX_SKIP] })
    expect(byRoute['/gone']).toMatchObject({ success: false, error: NOINDEX_SKIP })
    expect(attempts.get('/gone')).toBe(2)
  })

  it('processRoutes_NoindexFirstTime_IsFinalAndNotRetried', async () => {
    const { byRoute, attempts } = await run({ '/draft': [NOINDEX_SKIP] })
    expect(byRoute['/draft'].error).toBe(NOINDEX_SKIP)
    expect(attempts.get('/draft')).toBe(1)
  })

  it('processRoutes_TransientFailure_ReplacedBySuccess', async () => {
    const { byRoute } = await run({ '/flaky': ['API HTTP 500', 'ok'] })
    expect(byRoute['/flaky'].success).toBe(true)
  })

  // Every attempt is reported, retries included and marked, so the worker can see the job moving.
  it('processRoutes_PersistentFailure_TriedThreeTimesEachAttemptEmitted', async () => {
    const { byRoute, attempts, events, results } = await run({ '/broken': ['API HTTP 500'], '/ok': ['ok'] })
    expect(byRoute['/broken']).toMatchObject({ success: false, error: 'API HTTP 500' })
    expect(attempts.get('/broken')).toBe(3)
    expect(results).toHaveLength(2)
    const brokenEvents = events.filter((e) => e.event === 'result' && e.route === '/broken')
    expect(brokenEvents.map((e) => e.retry ?? 0)).toEqual([0, 1, 2])
    expect(events.at(-1)).toMatchObject({ event: 'progress', rendered: 1, failed: 1, total: 2 })
  })
})
