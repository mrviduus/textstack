// @vitest-environment node
import { createServer, request } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import puppeteer from 'puppeteer'
import { NOINDEX_SKIP, renderRoute, startServer, stopServer } from './ssgRender.mjs'

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
})

// A page shaped like the app: it fetches its data through /api/, retries once, and on failure shows
// an error state — which, like BookDetailPage's, has an <h1> and no noindex. The route names the API
// path it loads; `noindex-on-error` adds noindex to the error state, as the not-found branches do.
const APP = `<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script>
(async () => {
  const root = document.getElementById('root')
  const name = location.pathname.split('/')[1]
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
})
