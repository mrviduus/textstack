#!/usr/bin/env node
/**
 * SSG Worker
 *
 * Long-running process that polls PostgreSQL for SSG rebuild jobs
 * and executes prerender.mjs for each job.
 *
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 *   API_URL - API base URL (default: http://api:8080)
 *   API_HOST - Host header for API requests (default: general.localhost)
 *   POLL_INTERVAL - Polling interval in ms (default: 5000)
 *   SENTRY_DSN - error reporting; unset = off (see ssgSentry.mjs)
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { rename, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { initSentry, routeFailuresToReport } from './ssgSentry.mjs';
import { assertBuildSurvived, createPool, reportOncePerOutage, waitForExit } from './ssgJob.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SSG directories for atomic swap.
//
// Derived from this file's own location, not written out absolutely. They used
// to be '/app/dist/...', which was true for as long as the container's WORKDIR
// was /app — and stopped being true the moment the image started building from
// the repository root and running out of /repo/apps/web. Every rebuild then
// failed with EACCES on mkdir '/app/dist/ssg-new' while the site kept serving
// the previous SSG, so nothing looked wrong from outside.
//
// prerender.mjs, next door, already resolved its own paths this way and was
// untouched by the move. This is that.
const DIST_DIR = join(__dirname, '..', 'dist');
const SSG_DIR = join(DIST_DIR, 'ssg');
const SSG_NEW_DIR = join(DIST_DIR, 'ssg-new');
const SSG_OLD_DIR = join(DIST_DIR, 'ssg-old');

// Configuration
const DATABASE_URL = process.env.DATABASE_URL;
const API_URL = process.env.API_URL || 'http://api:8080';
const API_HOST = process.env.API_HOST || 'general.localhost';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '5000', 10);

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// PostgreSQL pool
const pool = createPool(DATABASE_URL);

// Error reporting. Null when SENTRY_DSN is unset, and every call below is `sentry?.` for that reason.
const sentry = await initSentry();

/**
 * Poll for next job with status "Running"
 */
async function pollForJob() {
  const { rows } = await pool.query(`
    SELECT j.id, j.site_id, j.mode, j.concurrency, j.timeout_ms,
           j.book_slugs_json, j.author_slugs_json, j.genre_slugs_json,
           s.code as site_code, s.primary_domain
    FROM ssg_rebuild_jobs j
    JOIN sites s ON j.site_id = s.id
    WHERE j.status = 'Running'
    ORDER BY j.started_at
    LIMIT 1
  `);
  return rows[0] || null;
}

/**
 * Get routes from API.
 *
 * Sends an explicit Host header so SiteContextMiddleware can resolve the site.
 * The legacy `?site=` query-param override was removed in R1b (single-site); node
 * fetch would otherwise default Host to the URL host (`api`) → 404 → silent job
 * failure. API_HOST resolves to a seeded domain (`localhost` in compose, or the
 * `general.localhost` default) → DefaultSiteId == ICurrentSite.Id.
 */
async function getRoutesFromApi() {
  const url = `${API_URL}/ssg/routes`;
  console.log(`Fetching routes from ${url} (Host: ${API_HOST})`);

  const res = await fetch(url, { headers: { host: API_HOST } });

  if (!res.ok) {
    throw new Error(`Failed to fetch routes: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.routes || [];
}

/**
 * Update job progress in DB
 */
async function updateJobProgress(jobId, rendered, failed) {
  await pool.query(
    'UPDATE ssg_rebuild_jobs SET rendered_count = $1, failed_count = $2 WHERE id = $3',
    [rendered, failed, jobId]
  );
}

/**
 * Set job status.
 *
 * Also records the outcome next to the heartbeat, because the heartbeat alone
 * says the wrong thing. The container healthcheck used to ask only whether this
 * loop was still ticking, so a worker that had failed every job for an hour
 * reported `Up (healthy)` — which is exactly what `docker compose ps` showed
 * while every rebuild died on EACCES and the site served stale pages to
 * crawlers. A process that is running and getting nothing done is not healthy.
 *
 * Written here rather than at the call sites: this is the one funnel every
 * outcome passes through, including the catch, so a new code path cannot forget.
 */
const LAST_JOB_FILE = '/tmp/ssg-worker-last-job';

async function setJobStatus(jobId, status, error = null) {
  try {
    writeFileSync(LAST_JOB_FILE, status);
  } catch {
    // Never let the marker stop the job from being recorded in the database,
    // which is the part that matters.
  }
  if (error) {
    await pool.query(
      `UPDATE ssg_rebuild_jobs SET status = $1, error = $2, finished_at = NOW() WHERE id = $3`,
      [status, error, jobId]
    );
  } else {
    await pool.query(
      `UPDATE ssg_rebuild_jobs SET status = $1, finished_at = NOW() WHERE id = $2`,
      [status, jobId]
    );
  }
}

/**
 * Process a single job
 */
async function processJob(job) {
  const jobId = job.id;
  const siteCode = job.site_code;
  const apiHost = job.primary_domain || API_HOST;

  console.log(`Processing job ${jobId} for site ${siteCode} (${apiHost})`);

  try {
    // 1. Get routes via API (site resolved from the Host header)
    const routes = await getRoutesFromApi();
    console.log(`Got ${routes.length} routes to render`);

    if (routes.length === 0) {
      console.log('No routes to render, marking as completed');
      await setJobStatus(jobId, 'Completed');
      return;
    }

    // 2. Update job with total routes
    await pool.query(
      'UPDATE ssg_rebuild_jobs SET total_routes = $1 WHERE id = $2',
      [routes.length, jobId]
    );

    // 3. Write routes to temp file
    const routesFile = `/tmp/ssg-routes-${jobId}.json`;
    const outputFile = `/tmp/ssg-results-${jobId}.json`;
    writeFileSync(routesFile, JSON.stringify(routes));

    // 4. Spawn prerender.mjs (output to ssg-new for atomic swap)
    const prerenderScript = join(__dirname, 'prerender.mjs');
    const args = [
      prerenderScript,
      '--routes-file', routesFile,
      '--output', outputFile,
      '--output-dir', SSG_NEW_DIR,
      '--concurrency', String(job.concurrency || 4),
    ];

    console.log(`Spawning: node ${args.join(' ')}`);

    const proc = spawn('node', args, {
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        API_URL,
        API_HOST: apiHost,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 5. Parse stdout for progress events
    let buffer = '';
    proc.stdout.on('data', async (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'progress') {
            await updateJobProgress(jobId, event.rendered, event.failed);
          } else if (event.event === 'complete') {
            console.log(`Prerender complete: ${event.rendered} rendered, ${event.failed} failed`);
          }
        } catch {
          // Not JSON, just log it
          console.log(`[prerender] ${line}`);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      console.error(`[prerender stderr] ${data.toString().trim()}`);
    });

    // 6. Wait for completion
    const { code: exitCode } = await waitForExit(proc);

    // 7. Report routes that never rendered — prerender exits 0 with failures, so the job status
    // alone would never show them. Before cleanup, which deletes the results file.
    reportRouteFailures(jobId, outputFile);

    // 8. Cleanup temp files
    try {
      unlinkSync(routesFile);
    } catch {}
    try {
      unlinkSync(outputFile);
    } catch {}

    // 9. Update job status based on exit code
    if (exitCode === 0) {
      // A clean exit says the renders succeeded, not that they survived. Deploy wipes
      // apps/web/dist to rebuild the frontend and only snapshots dist/ssg — a rebuild
      // running at that moment has its dist/ssg-new emptied underneath it, then promotes
      // the remains over the good tree the deploy just restored. That is how the whole
      // site went 404-to-crawlers on 2026-08-31. Count what is actually on disk before
      // trusting it; throwing lands in the catch, which keeps dist/ssg untouched.
      assertBuildSurvived(SSG_NEW_DIR, routes.length);

      // Atomic swap: ssg-new → ssg
      await atomicSwap();

      // Submit to IndexNow (Bing/Yandex)
      if (process.env.INDEXNOW_ENABLED === 'true' && process.env.INDEXNOW_KEY) {
        await submitToIndexNow(job.primary_domain, routes);
      }

      console.log(`Job ${jobId} completed successfully`);
      await setJobStatus(jobId, 'Completed');
    } else {
      // Cleanup failed build
      await cleanupFailedBuild();
      console.error(`Job ${jobId} failed with exit code ${exitCode}`);
      const reason = `Prerender process exited with code ${exitCode}`;
      sentry?.jobFailed(jobId, new Error(reason));
      await setJobStatus(jobId, 'Failed', reason);
    }
  } catch (error) {
    console.error(`Error processing job ${jobId}:`, error);
    sentry?.jobFailed(jobId, error);
    await cleanupFailedBuild();
    await setJobStatus(jobId, 'Failed', error.message || String(error));
  }
}

/**
 * One Sentry event per route that failed to render, from prerender's results file. A missing or
 * unreadable file is not reported here: prerender then exited non-zero, and that is reported as
 * the job's failure.
 */
function reportRouteFailures(jobId, resultsFile) {
  if (!sentry) return;
  let results;
  try {
    results = JSON.parse(readFileSync(resultsFile, 'utf8'));
  } catch {
    return;
  }
  sentry.routesFailed(jobId, routeFailuresToReport(results));
}

/**
 * Submit URLs to IndexNow (Bing/Yandex instant indexing)
 */
async function submitToIndexNow(host, routes) {
  const key = process.env.INDEXNOW_KEY;
  if (!key || !host) return;

  // IndexNow verifies ownership by fetching https://<host>/<key>.txt. If that file isn't ours, nginx
  // answers with the SPA's index.html and every submission is a 403 — which is what happened from
  // late April to 2026-09: prod's INDEXNOW_KEY and the committed key file were two different keys.
  const keyFile = join(DIST_DIR, `${key}.txt`);
  if (!existsSync(keyFile) || readFileSync(keyFile, 'utf8').trim() !== key) {
    console.error(`IndexNow: skipped — ${key}.txt is missing from apps/web/public or doesn't contain the key; INDEXNOW_KEY and the key file disagree`);
    return;
  }

  const urlList = routes.map(r => `https://${host}${r}`);
  const BATCH_SIZE = 10000; // IndexNow limit

  // api.indexnow.org answers with Bing's verdict, and a URL is shared with the other engines only once
  // it is accepted — so while Bing refuses, Yandex hears nothing. Submitting to Yandex directly
  // decouples them — and Yandex shares what it accepts, so Bing gets the URLs that way. A duplicate
  // once Bing accepts directly is harmless.
  const endpoints = ['https://api.indexnow.org/indexnow', 'https://yandex.com/indexnow'];

  for (let i = 0; i < urlList.length; i += BATCH_SIZE) {
    const batch = urlList.slice(i, i + BATCH_SIZE);
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            host,
            key,
            keyLocation: `https://${host}/${key}.txt`,
            urlList: batch
          })
        });
        // The body carries the reason (e.g. Bing's "UserForbiddedToAccessSite"); a bare status hid
        // two different 403s behind one log line.
        const detail = res.ok ? '' : ` ${(await res.text()).slice(0, 200)}`;
        console.log(`IndexNow ${new URL(endpoint).host}: ${batch.length} URLs → ${res.status}${detail}`);
      } catch (err) {
        console.error(`IndexNow ${new URL(endpoint).host} error:`, err.message);
        // Don't fail SSG if IndexNow fails
      }
    }
  }
}

/**
 * Atomic swap: ssg-new → ssg (zero downtime)
 */
async function atomicSwap() {
  console.log('Starting atomic swap...');

  // 1. Remove old backup if exists
  await rm(SSG_OLD_DIR, { recursive: true, force: true });

  // 2. Move current to old (if exists)
  if (existsSync(SSG_DIR)) {
    await rename(SSG_DIR, SSG_OLD_DIR);
    console.log(`  ${SSG_DIR} → ${SSG_OLD_DIR}`);
  }

  // 3. Move new to current
  await rename(SSG_NEW_DIR, SSG_DIR);
  console.log(`  ${SSG_NEW_DIR} → ${SSG_DIR}`);

  // 4. Cleanup old
  await rm(SSG_OLD_DIR, { recursive: true, force: true });
  console.log('Atomic swap completed');
}

/**
 * Cleanup failed build (remove ssg-new, keep ssg intact)
 */
async function cleanupFailedBuild() {
  await rm(SSG_NEW_DIR, { recursive: true, force: true });
  console.log('Cleaned up failed build');
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main loop
 */
async function main() {
  console.log('SSG Worker started');
  console.log(`  DATABASE_URL: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  API_URL: ${API_URL}`);
  console.log(`  API_HOST: ${API_HOST}`);
  console.log(`  POLL_INTERVAL: ${POLL_INTERVAL}ms`);
  console.log(`  SENTRY: ${sentry ? 'on' : 'off'}`);

  // Test DB connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection OK');
  } catch (err) {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  }

  // Heartbeat file — docker healthcheck reads mtime
  const HEARTBEAT = '/tmp/ssg-worker-alive';
  setInterval(() => {
    try {
      writeFileSync(HEARTBEAT, new Date().toISOString());
    } catch (err) {
      console.warn('Failed to write heartbeat:', err.message);
    }
  }, 30_000);
  writeFileSync(HEARTBEAT, new Date().toISOString());

  // A persistent poll-loop failure (the database gone, a renamed column) is one event rather than
  // one every POLL_INTERVAL. Cleared by the next poll that succeeds.
  const loopErrors = reportOncePerOutage((error) => sentry?.error(error));

  // Main polling loop
  while (true) {
    try {
      const job = await pollForJob();
      loopErrors.recovered();

      if (job) {
        await processJob(job);
      } else {
        await sleep(POLL_INTERVAL);
      }
    } catch (error) {
      console.error('Error in main loop:', error);
      loopErrors.report(error);
      await sleep(POLL_INTERVAL);
    }
  }
}

// Handle shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await sentry?.close();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await sentry?.close();
  await pool.end();
  process.exit(0);
});

// Start
main().catch(async (err) => {
  console.error('Fatal error:', err);
  sentry?.error(err);
  await sentry?.close();
  process.exit(1);
});
