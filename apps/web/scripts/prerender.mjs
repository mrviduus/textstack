#!/usr/bin/env node
/**
 * SSG Prerender Script
 *
 * Renders SEO pages to static HTML at build time.
 * Uses Puppeteer to render React app and extract final HTML.
 *
 * Usage:
 *   node prerender.mjs                           # Fetch routes from API
 *   node prerender.mjs --routes-file routes.json # Read routes from file
 *   node prerender.mjs --output results.json     # Write results to file
 *   node prerender.mjs --concurrency 8           # Override concurrency
 */

import puppeteer from 'puppeteer';
import { createServer, request as httpRequest } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');
const SSG_DIR = join(DIST_DIR, 'ssg');

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    routesFile: null,
    outputFile: null,
    concurrency: parseInt(process.env.CONCURRENCY || '4', 10),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--routes-file' && args[i + 1]) {
      opts.routesFile = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.outputFile = args[++i];
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    }
  }

  return opts;
}

const CLI_OPTS = parseArgs();

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:8080';
const API_HOST = process.env.API_HOST || 'general.localhost';
const CONCURRENCY = CLI_OPTS.concurrency;
const PORT = 3456;

// Parse API URL
const apiUrl = new URL(API_URL);

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
 * Emit a JSON event to stdout for Worker to parse
 */
function emitEvent(event) {
  console.log(JSON.stringify(event));
}

/**
 * Proxy request to API
 */
function proxyToApi(req, res, path) {
  const options = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || 80,
    path: path,
    method: req.method,
    headers: {
      ...req.headers,
      host: API_HOST,
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
 * Start a static file server with API proxy
 */
function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url.split('?')[0];

      // Proxy API requests (React app uses /api prefix)
      if (url.startsWith('/api/') || url.startsWith('/api')) {
        const apiPath = url.replace(/^\/api/, '');
        return proxyToApi(req, res, apiPath || '/');
      }

      // Proxy storage requests (images, covers)
      if (url.startsWith('/storage')) {
        return proxyToApi(req, res, url);
      }

      // Static files
      let filePath = join(DIST_DIR, url === '/' ? '/index.html' : url);

      // SPA fallback: serve index.html for all non-file routes
      if (!existsSync(filePath) || !filePath.includes('.')) {
        filePath = join(DIST_DIR, 'index.html');
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

    server.listen(PORT, () => {
      console.log(`Static server with API proxy running at http://localhost:${PORT}`);
      console.log(`API proxy target: ${API_URL} (Host: ${API_HOST})`);
      resolve(server);
    });
  });
}

/**
 * Fetch routes from SSG API endpoint using http module (to set Host header)
 */
function fetchRoutesFromApi() {
  return new Promise((resolve, reject) => {
    console.log(`Fetching routes from ${API_URL}/ssg/routes...`);

    const options = {
      hostname: apiUrl.hostname,
      port: apiUrl.port || 80,
      path: '/ssg/routes',
      method: 'GET',
      headers: {
        'Host': API_HOST,
        'Accept': 'application/json',
      },
    };

    const req = httpRequest(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch routes: ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          console.log(`Found ${json.count} routes to prerender`);
          // Convert to array of route objects
          resolve(json.routes.map(route => ({ route, routeType: 'unknown' })));
        } catch (err) {
          reject(new Error(`Failed to parse routes: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Load routes from JSON file
 */
function loadRoutesFromFile(filePath) {
  console.log(`Loading routes from ${filePath}...`);
  const content = readFileSync(filePath, 'utf-8');
  const routes = JSON.parse(content);
  console.log(`Found ${routes.length} routes to prerender`);
  return routes;
}

/**
 * Get routes from file or API
 */
async function getRoutes() {
  if (CLI_OPTS.routesFile) {
    return loadRoutesFromFile(CLI_OPTS.routesFile);
  }
  return fetchRoutesFromApi();
}

/**
 * Render a single route using Puppeteer
 */
async function renderRoute(browser, routeObj) {
  const route = typeof routeObj === 'string' ? routeObj : routeObj.route || routeObj.Route;
  const routeType = typeof routeObj === 'string' ? 'unknown' : (routeObj.routeType || routeObj.RouteType || 'unknown');

  const page = await browser.newPage();
  const startTime = Date.now();

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
    }, PORT);

    // Navigate to the route
    const url = `http://localhost:${PORT}${route}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for React to render actual content (not skeleton)
    await page.waitForFunction(() => {
      // Check no skeleton AND actual content exists
      const skeleton = document.querySelector('.book-detail__skeleton, .books-grid__skeleton, .author-detail__skeleton, .genre-detail__skeleton');
      if (skeleton) return false;

      // Check for loaded content indicators
      const bookDetail = document.querySelector('.book-detail__header h1');
      const booksList = document.querySelector('.books-grid .book-card:not(.book-card--skeleton)');
      const authorDetail = document.querySelector('.author-detail__name');
      const genreDetail = document.querySelector('.genre-detail__title');
      const staticPage = document.querySelector('.about-page, .static-content, main h1');

      return bookDetail || booksList || authorDetail || genreDetail || staticPage;
    }, { timeout: 15000 }).catch(() => {
      // Content may not be available (404, error page, etc) - continue with current state
    });

    // Shorter wait since we already waited for content
    await new Promise(r => setTimeout(r, 200));

    // Get the rendered HTML
    const html = await page.content();

    // Determine output path
    const outputPath = route.endsWith('/')
      ? join(SSG_DIR, route, 'index.html')
      : join(SSG_DIR, route, 'index.html');

    // Create directory and write file
    const outputDir = dirname(outputPath);
    mkdirSync(outputDir, { recursive: true });
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

/**
 * Process routes in batches with concurrency control
 */
async function processRoutes(browser, routes) {
  const results = [];
  let rendered = 0;
  let failed = 0;
  const total = routes.length;

  // Process in batches
  for (let i = 0; i < routes.length; i += CONCURRENCY) {
    const batch = routes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(routeObj => renderRoute(browser, routeObj))
    );

    for (const result of batchResults) {
      results.push(result);

      if (result.success) {
        rendered++;
      } else {
        failed++;
      }

      // Emit result event for each route
      emitEvent({
        event: 'result',
        route: result.route,
        routeType: result.routeType,
        success: result.success,
        renderTimeMs: result.renderTimeMs,
        error: result.error || null,
      });
    }

    // Emit progress event after each batch
    emitEvent({
      event: 'progress',
      rendered,
      failed,
      total,
    });

    // Also print progress for human-readable output
    process.stderr.write(`\rPrerendered ${rendered + failed}/${total} routes...`);
  }

  process.stderr.write('\n'); // New line after progress
  return results;
}

/**
 * Main function
 */
async function main() {
  console.log('=== SSG Prerender Script ===\n');

  // Check if dist folder exists
  if (!existsSync(DIST_DIR)) {
    console.error('Error: dist folder not found. Run "pnpm build" first.');
    process.exit(1);
  }

  // Get routes
  const routes = await getRoutes();

  // Create SSG output directory
  mkdirSync(SSG_DIR, { recursive: true });

  // Start static server
  const server = await startServer();

  // Launch browser
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // Process all routes
    console.log(`\nStarting prerender with concurrency=${CONCURRENCY}...\n`);
    const results = await processRoutes(browser, routes);

    // Write results to output file if specified
    if (CLI_OPTS.outputFile) {
      writeFileSync(CLI_OPTS.outputFile, JSON.stringify(results, null, 2));
      console.log(`Results written to ${CLI_OPTS.outputFile}`);
    }

    // Summary
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log('\n=== Prerender Complete ===');
    console.log(`Success: ${successCount}`);
    console.log(`Failed: ${failedCount}`);

    if (failedCount > 0) {
      console.log('\nFailed routes:');
      for (const err of results.filter(r => !r.success).slice(0, 10)) {
        console.log(`  ${err.route}: ${err.error}`);
      }
      if (failedCount > 10) {
        console.log(`  ... and ${failedCount - 10} more`);
      }
    }

    console.log(`\nOutput: ${SSG_DIR}`);

  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(err => {
  console.error('Prerender failed:', err);
  process.exit(1);
});
