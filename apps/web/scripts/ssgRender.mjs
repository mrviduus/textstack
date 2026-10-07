/**
 * The rendering half of SSG, run inside prerender.mjs: a static server with an API proxy for the
 * headless browser, and the rule for what one route's render produced.
 *
 * Its own module so the tests can drive it; prerender.mjs is the CLI around it.
 */

import { createServer, request as httpRequest } from 'http';
import { pipeline } from 'stream';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

/** A render that is skipped on purpose: the page is a 404 or a draft, so no file is written. */
export const NOINDEX_SKIP = 'Page has noindex meta tag';

// MIME types for static server
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** How long the proxy waits on the API before answering the page 504 itself. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Proxy request to API.
 *
 * Every request it opens to the API ends when the browser's does, or after `upstreamTimeoutMs`.
 * It used to have neither: against an API that accepted connections and never answered, the
 * requests stayed open after the pages that made them had closed, and they kept prerender's event
 * loop alive after its last route — so it never exited, and the job stayed Running.
 */
function proxyToApi(req, res, path, { apiUrl, apiHost, upstreamTimeoutMs }) {
  const options = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || 80,
    path: path,
    method: req.method,
    headers: {
      ...req.headers,
      host: apiHost,
    },
  };

  const proxyReq = httpRequest(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // pipeline, not pipe: an API that drops the connection mid-body ends this response too,
    // instead of an unhandled 'error' on proxyRes.
    pipeline(proxyRes, res, () => {});
  });

  // The page gave up (its fetch timed out, it was closed, the server is stopping).
  res.on('close', () => {
    if (!res.writableFinished) proxyReq.destroy();
  });

  let timedOut = false;
  proxyReq.setTimeout(upstreamTimeoutMs, () => {
    timedOut = true;
    proxyReq.destroy();
  });

  proxyReq.on('error', (err) => {
    if (res.destroyed) return; // the page is gone; nobody to answer
    if (res.headersSent) return void res.destroy();
    console.error(`Proxy error: ${timedOut ? `no answer in ${upstreamTimeoutMs} ms` : err.message}`);
    res.writeHead(timedOut ? 504 : 502);
    res.end(timedOut ? 'Gateway Timeout' : 'Bad Gateway');
  });

  req.pipe(proxyReq);
}

/**
 * Start a static file server with API proxy. `port` 0 picks a free one (tests); read it back from
 * `server.address().port`.
 */
export function startServer({ distDir, apiUrl, apiHost, port, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS }) {
  const api = { apiUrl: new URL(apiUrl), apiHost, upstreamTimeoutMs };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // The path alone picks the handler and the static file; the query goes on to the API. It was
      // dropped for both until 2026-10, so pages rendered with the API's defaults (limit, sort).
      const url = req.url.split('?')[0];
      const query = req.url.slice(url.length);

      // Proxy API requests (React app uses /api prefix). Whole segments only: /apiary is the app's.
      if (url === '/api' || url.startsWith('/api/')) {
        const apiPath = url.replace(/^\/api/, '');
        return proxyToApi(req, res, (apiPath || '/') + query, api);
      }

      // Proxy storage requests (images, covers)
      if (url === '/storage' || url.startsWith('/storage/')) {
        return proxyToApi(req, res, url + query, api);
      }

      // Static files
      let filePath = join(distDir, url === '/' ? '/index.html' : url);

      // SPA fallback: serve index.html for all non-file routes
      if (!existsSync(filePath) || !filePath.includes('.')) {
        filePath = join(distDir, 'index.html');
      }

      try {
        const content = readFileSync(filePath);
        const ext = filePath.substring(filePath.lastIndexOf('.'));
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      } catch (err) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(port, () => {
      console.log(`Static server with API proxy running at http://localhost:${server.address().port}`);
      console.log(`API proxy target: ${apiUrl} (Host: ${apiHost})`);
      resolve(server);
    });
  });
}

/**
 * Stops the server, closing the connections still open rather than waiting for them: `close()`
 * alone waits on every in-flight request, and a request to a hung API never finishes.
 */
export function stopServer(server) {
  const closed = new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  return closed;
}

/**
 * Each URL's outcome is that of its last request that has one: the app retries, and a 503 followed
 * by a 200 is a page whose data arrived. A request still in flight leaves the previous outcome.
 */
function finalOutcomeByUrl(requests, outcomes) {
  const byUrl = new Map();
  for (const req of requests) {
    if (outcomes.has(req)) byUrl.set(req.url(), outcomes.get(req));
  }
  return byUrl;
}

/** An API call is broken when its last outcome is a 5xx, a 429, or no response at all. */
function isApiFailure(outcome) {
  return outcome.failure !== undefined || outcome.status >= 500 || outcome.status === 429;
}

/**
 * Render a single route using Puppeteer
 */
export async function renderRoute(browser, routeObj, { outputDir, port }) {
  const route = typeof routeObj === 'string' ? routeObj : routeObj.route || routeObj.Route;
  const routeType = typeof routeObj === 'string' ? 'unknown' : (routeObj.routeType || routeObj.RouteType || 'unknown');

  const page = await browser.newPage();
  const startTime = Date.now();

  // Capture diagnostics for timeout reporting
  const consoleMessages = [];
  const failedRequests = [];
  page.on('console', msg => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      consoleMessages.push(`[${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', err => consoleMessages.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText || 'unknown'}`));
  page.on('response', res => {
    if (res.status() >= 400) failedRequests.push(`HTTP ${res.status()} ${res.url()}`);
  });

  // The outcome of each of the page's API requests. A page counts as rendered only if its data
  // loaded: an error state is a perfectly good-looking page (an <h1>, no noindex), and before this
  // one was saved as SSG whenever the API was down.
  //
  // Keyed by request, not URL. A request that got a status keeps it: the app reads a 404 or a 503
  // and moves on without reading the body, and the browser then aborts that body — a requestfailed
  // for a request that WAS answered. Keyed by URL, that abort overwrote the 404, and a deleted book
  // counted as an API failure whose stale page was carried forward forever. Only a request with no
  // response at all is "no response".
  const apiPrefix = `http://localhost:${port}/api/`;
  const apiRequests = []; // in the order the page made them
  const apiOutcomes = new Map(); // HTTPRequest → { status } | { failure }
  page.on('request', req => {
    if (req.url().startsWith(apiPrefix)) apiRequests.push(req);
  });
  page.on('response', res => {
    if (res.url().startsWith(apiPrefix)) apiOutcomes.set(res.request(), { status: res.status() });
  });
  page.on('requestfailed', req => {
    if (req.url().startsWith(apiPrefix) && !apiOutcomes.has(req)) {
      apiOutcomes.set(req, { failure: req.failure()?.errorText || 'failed' });
    }
  });

  try {
    // Set viewport for consistent rendering
    await page.setViewport({ width: 1280, height: 800 });

    // Override fetch to redirect localhost:8080 API calls to our proxy
    await page.evaluateOnNewDocument((proxyPort) => {
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        let url = typeof input === 'string' ? input : input.url;
        if (url.includes('localhost:8080')) {
          // Rewrite to proxy, avoiding double /api prefix
          let newUrl = url.replace('http://localhost:8080', `http://localhost:${proxyPort}`);
          if (!newUrl.includes('/api/')) {
            newUrl = newUrl.replace(`http://localhost:${proxyPort}/`, `http://localhost:${proxyPort}/api/`);
          }
          if (typeof input === 'string') {
            return originalFetch.call(this, newUrl, init);
          } else {
            return originalFetch.call(this, new Request(newUrl, input), init);
          }
        }
        return originalFetch.call(this, input, init);
      };
    }, port);

    // Navigate to the route
    const url = `http://localhost:${port}${route}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for React to render (content OR error page)
    // Returns: 'content' | 'error' | 'skeleton' (still loading)
    const renderState = await page.waitForFunction(() => {
      // Check for error pages first (fast exit)
      const errorPage = document.querySelector('.error-page, .not-found, [class*="error"], [class*="not-found"]');
      const errorText = document.body?.innerText || '';
      if (errorPage || errorText.includes('not found') || errorText.includes('404') || errorText.includes('API error')) {
        return 'error';
      }

      // Check if still loading (skeleton visible)
      const skeleton = document.querySelector('.book-detail__skeleton, .books-grid__skeleton, .author-detail__skeleton, .author-detail__header--skeleton, .genre-detail__skeleton');
      if (skeleton) return 'skeleton';

      // Check for loaded content (match H1 tags specifically, not shared skeleton classes)
      const bookDetail = document.querySelector('h1.book-hero__title, .book-detail__header h1');
      const booksList = document.querySelector('.books-grid .book-card:not(.book-card--skeleton)');
      const authorDetail = document.querySelector('h1.author-detail__name');
      const genreDetail = document.querySelector('h1.genre-detail__title, .genre-detail__title');
      const staticPage = document.querySelector('.about-page, .static-content, main h1');
      const homePage = document.querySelector('.home-hero__title');
      const listPage = document.querySelector('.authors-page h1, .genres-page h1');

      if (bookDetail || booksList || authorDetail || genreDetail || staticPage || homePage || listPage) {
        return 'content';
      }

      return null; // Keep waiting
    }, { timeout: 5000 }).then(h => h?.jsonValue()).catch(() => 'timeout');

    // Before the noindex check below: the app's error states for a missing book or author carry
    // noindex too, and a deliberate noindex skip drops the page where a failure keeps the old one.
    const apiFailures = [...finalOutcomeByUrl(apiRequests, apiOutcomes)]
      .filter(([, outcome]) => isApiFailure(outcome))
      .map(([u, outcome]) => `${outcome.failure ?? `HTTP ${outcome.status}`} ${new URL(u).pathname}`);
    if (apiFailures.length > 0) {
      throw new Error(
        `prerender failed for ${route}: API ${apiFailures.join(', ')}\n    renderState=${renderState}`
      );
    }

    // Fail loudly on timeout or skeleton — previously we silently saved empty shells,
    // producing 247 SSG files with no H1, canonical, or og:image. Bots got nothing.
    if (renderState === 'timeout' || renderState === 'skeleton') {
      const bodySnippet = await page.evaluate(() => {
        const root = document.querySelector('#root');
        return (root?.innerHTML || document.body?.innerHTML || '').slice(0, 500);
      }).catch(() => '<unavailable>');
      const diag = [
        `renderState=${renderState}`,
        `console: ${consoleMessages.slice(-10).join(' | ') || '<none>'}`,
        `failedRequests: ${failedRequests.slice(-10).join(' | ') || '<none>'}`,
        `bodySnippet: ${bodySnippet.replace(/\s+/g, ' ')}`,
      ].join('\n    ');
      throw new Error(`prerender failed for ${route}\n    ${diag}`);
    }

    // Small stabilization delay for successful content
    if (renderState === 'content') {
      await new Promise(r => setTimeout(r, 100));
    }

    // Get the rendered HTML
    let html = await page.content();

    // Skip saving pages with noindex (a real 404, a draft). Deliberate, so the worker does not keep
    // the previous copy: the page has left the index.
    const hasNoindex = html.includes('content="noindex');
    if (hasNoindex) {
      const renderTimeMs = Date.now() - startTime;
      return { route, routeType, success: false, error: NOINDEX_SKIP, renderTimeMs };
    }

    // Strip JS module scripts to prevent hydration overwriting SSG content
    // Googlebot executes JS which causes React to re-render and potentially show errors
    html = html.replace(/<script type="module"[^>]*crossorigin[^>]*src="\/assets\/[^"]*"[^>]*><\/script>/g, '');
    // Also strip modulepreload links
    html = html.replace(/<link rel="modulepreload"[^>]*href="\/assets\/[^"]*"[^>]*\/?>/g, '');

    // Determine output path
    const outputPath = join(outputDir, route, 'index.html');

    // Create directory and write file
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);

    const renderTimeMs = Date.now() - startTime;
    return { route, routeType, success: true, renderTimeMs };
  } catch (error) {
    const renderTimeMs = Date.now() - startTime;
    return { route, routeType, success: false, error: error.message, renderTimeMs };
  } finally {
    await page.close();
  }
}

const MAX_RETRIES = 2;

/**
 * Renders every route, `concurrency` at a time, then retries the failures up to MAX_RETRIES times.
 * `render(routeObj)` returns one result. `emit` gets a `result` event per attempt (a retry's carries
 * `retry: n`) and a `progress` event per batch — the worker reads both from stdout.
 *
 * A retry that reaches a definitive outcome — rendered, or noindex — replaces the earlier failure.
 * It used to replace it only on success, so a route that failed once (a transient 503) and was a
 * draft or gone by its retry kept the failure, and the worker carried its old page forward. A
 * noindex result is final and is not retried.
 */
export async function processRoutes(routes, render, { concurrency, emit = () => {} }) {
  const results = [];
  const total = routes.length;
  const isFinal = (r) => r.success || r.error === NOINDEX_SKIP;
  const counts = () => {
    const rendered = results.filter((r) => r.success).length;
    return { rendered, failed: results.length - rendered };
  };
  const report = (result, retry) => emit({
    event: 'result',
    route: result.route,
    routeType: result.routeType,
    success: result.success,
    renderTimeMs: result.renderTimeMs,
    error: result.error || null,
    ...(retry ? { retry } : {}),
  });

  for (let i = 0; i < routes.length; i += concurrency) {
    const batchResults = await Promise.all(routes.slice(i, i + concurrency).map(render));
    for (const result of batchResults) {
      results.push(result);
      report(result, 0);
    }
    const { rendered, failed } = counts();
    emit({ event: 'progress', rendered, failed, total });
    process.stderr.write(`\rPrerendered ${rendered + failed}/${total} routes...`);
  }
  process.stderr.write('\n');

  for (let retry = 1; retry <= MAX_RETRIES; retry++) {
    const pending = results.map((r, idx) => ({ r, idx })).filter(({ r }) => !isFinal(r));
    if (pending.length === 0) break;
    process.stderr.write(`\nRetry ${retry}/${MAX_RETRIES}: ${pending.length} failed routes...\n`);

    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(({ r }) => render({ route: r.route, routeType: r.routeType }))
      );
      batchResults.forEach((result, k) => {
        if (isFinal(result)) results[batch[k].idx] = result;
        report(result, retry);
      });
    }

    const { rendered, failed } = counts();
    emit({ event: 'progress', rendered, failed, total });
    process.stderr.write(`After retry ${retry}: ${rendered} rendered, ${failed} failed\n`);
  }

  return results;
}
