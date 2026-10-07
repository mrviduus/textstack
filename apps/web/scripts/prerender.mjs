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
 *   node prerender.mjs --output-dir /tmp/ssg     # Write SSG files to custom dir
 *   node prerender.mjs --concurrency 8           # Override concurrency
 */

import puppeteer from 'puppeteer';
import { request as httpRequest } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import { startServer, stopServer, renderRoute } from './ssgRender.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', 'dist');

// CLI_OPTS parsed below, SSG_DIR defined after

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    routesFile: null,
    outputFile: null,
    outputDir: null,
    concurrency: parseInt(process.env.CONCURRENCY || '4', 10),
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--routes-file' && args[i + 1]) {
      opts.routesFile = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      opts.outputFile = args[++i];
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      opts.outputDir = args[++i];
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = parseInt(args[++i], 10);
    }
  }

  return opts;
}

const CLI_OPTS = parseArgs();

// SSG output directory (custom via --output-dir or default dist/ssg)
const SSG_DIR = CLI_OPTS.outputDir
  ? (isAbsolute(CLI_OPTS.outputDir) ? CLI_OPTS.outputDir : join(process.cwd(), CLI_OPTS.outputDir))
  : join(DIST_DIR, 'ssg');

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:8080';
const API_HOST = process.env.API_HOST || 'general.localhost';
const CONCURRENCY = CLI_OPTS.concurrency;
const PORT = 3456;

// Parse API URL
const apiUrl = new URL(API_URL);
const RENDER_OPTS = { outputDir: SSG_DIR, port: PORT };

/**
 * Emit a JSON event to stdout for Worker to parse
 */
function emitEvent(event) {
  console.log(JSON.stringify(event));
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
      batch.map(routeObj => renderRoute(browser, routeObj, RENDER_OPTS))
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

  // Retry failed routes up to 2 times
  const MAX_RETRIES = 2;
  for (let retry = 1; retry <= MAX_RETRIES; retry++) {
    const failedRoutes = results.filter(r => !r.success);
    if (failedRoutes.length === 0) break;

    process.stderr.write(`\nRetry ${retry}/${MAX_RETRIES}: ${failedRoutes.length} failed routes...\n`);

    for (let i = 0; i < failedRoutes.length; i += CONCURRENCY) {
      const batch = failedRoutes.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(prev => renderRoute(browser, { route: prev.route, routeType: prev.routeType }, RENDER_OPTS))
      );

      for (const result of batchResults) {
        if (result.success) {
          // Replace failed result with success
          const idx = results.findIndex(r => r.route === result.route);
          if (idx !== -1) {
            results[idx] = result;
            rendered++;
            failed--;
          }

          emitEvent({
            event: 'result',
            route: result.route,
            routeType: result.routeType,
            success: true,
            renderTimeMs: result.renderTimeMs,
            error: null,
          });
        }
      }
    }

    emitEvent({ event: 'progress', rendered, failed, total });
    process.stderr.write(`After retry ${retry}: ${rendered} rendered, ${failed} failed\n`);
  }

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
  const server = await startServer({ distDir: DIST_DIR, apiUrl: API_URL, apiHost: API_HOST, port: PORT });

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
    await stopServer(server);
  }
}

main().then(() => {
  // Everything main() opened is closed by now, and the process normally exits here on its own. If
  // something still holds the event loop, it must not hold the rebuild job: the results are
  // written, so finish. unref() keeps this timer from being that something.
  setTimeout(() => {
    console.error('Prerender finished but was still running 10 s later; exiting');
    process.exit(0);
  }, 10_000).unref();
}).catch(err => {
  console.error('Prerender failed:', err);
  process.exit(1);
});
