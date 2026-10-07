/**
 * The rendering half of SSG, run inside prerender.mjs: a static server with an API proxy for the
 * headless browser, and the rule for what one route's render produced.
 *
 * Its own module so the tests can drive it; prerender.mjs is the CLI around it.
 */

import { createServer, request as httpRequest } from 'http';
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

/**
 * Proxy request to API
 */
function proxyToApi(req, res, path, { apiUrl, apiHost }) {
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
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}

/**
 * Start a static file server with API proxy. `port` 0 picks a free one (tests); read it back from
 * `server.address().port`.
 */
export function startServer({ distDir, apiUrl, apiHost, port }) {
  const api = { apiUrl: new URL(apiUrl), apiHost };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url.split('?')[0];

      // Proxy API requests (React app uses /api prefix)
      if (url.startsWith('/api/') || url.startsWith('/api')) {
        const apiPath = url.replace(/^\/api/, '');
        return proxyToApi(req, res, apiPath || '/', api);
      }

      // Proxy storage requests (images, covers)
      if (url.startsWith('/storage')) {
        return proxyToApi(req, res, url, api);
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

/** Stops the server. */
export function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
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

    // Skip saving pages with noindex (real 404 or error state) — keep existing SSG file
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
