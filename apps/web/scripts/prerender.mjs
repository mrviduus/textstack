#!/usr/bin/env node
/**
 * SSG Prerender Script
 *
 * Renders SEO pages to static HTML at build time.
 * Uses Puppeteer to render React app and extract final HTML.
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

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:8080';
const API_HOST = process.env.API_HOST || 'general.localhost';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
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
function fetchRoutes() {
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
          resolve(json.routes);
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
 * Render a single route using Puppeteer
 */
async function renderRoute(browser, route) {
  const page = await browser.newPage();

  try {
    // Set viewport for consistent rendering
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate to the route
    const url = `http://localhost:${PORT}${route}`;
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for React to render
    await page.waitForFunction(() => {
      // Check if SeoHead has set the title
      const title = document.title;
      return title && title !== 'TextStack' && !title.includes('Loading');
    }, { timeout: 10000 }).catch(() => {
      // Timeout is OK for some pages, continue with current state
    });

    // Additional wait for dynamic content
    await new Promise(r => setTimeout(r, 500));

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

    return { route, success: true };
  } catch (error) {
    return { route, success: false, error: error.message };
  } finally {
    await page.close();
  }
}

/**
 * Process routes in batches with concurrency control
 */
async function processRoutes(browser, routes) {
  const results = { success: 0, failed: 0, errors: [] };

  // Process in batches
  for (let i = 0; i < routes.length; i += CONCURRENCY) {
    const batch = routes.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(route => renderRoute(browser, route))
    );

    for (const result of batchResults) {
      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({ route: result.route, error: result.error });
      }
    }

    // Progress update
    const progress = Math.min(i + CONCURRENCY, routes.length);
    process.stdout.write(`\rPrerendered ${progress}/${routes.length} routes...`);
  }

  console.log(); // New line after progress
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

  // Fetch routes
  const routes = await fetchRoutes();

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

    // Summary
    console.log('\n=== Prerender Complete ===');
    console.log(`Success: ${results.success}`);
    console.log(`Failed: ${results.failed}`);

    if (results.errors.length > 0) {
      console.log('\nFailed routes:');
      for (const err of results.errors.slice(0, 10)) {
        console.log(`  ${err.route}: ${err.error}`);
      }
      if (results.errors.length > 10) {
        console.log(`  ... and ${results.errors.length - 10} more`);
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
