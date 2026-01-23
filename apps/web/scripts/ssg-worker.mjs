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
 */

import pg from 'pg';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { rename, rm } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SSG directories for atomic swap
const SSG_DIR = '/app/dist/ssg';
const SSG_NEW_DIR = '/app/dist/ssg-new';
const SSG_OLD_DIR = '/app/dist/ssg-old';

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
const pool = new pg.Pool({ connectionString: DATABASE_URL });

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
 * Get routes from API
 * Uses ?site= query param instead of Host header (Node.js fetch doesn't pass Host properly)
 */
async function getRoutesFromApi(siteCode) {
  const url = `${API_URL}/ssg/routes?site=${siteCode}`;
  console.log(`Fetching routes from ${url}`);

  const res = await fetch(url);

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
 * Set job status
 */
async function setJobStatus(jobId, status, error = null) {
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
    // 1. Get routes via API (uses ?site= query param)
    const routes = await getRoutesFromApi(siteCode);
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
    const exitCode = await new Promise((resolve) => {
      proc.on('close', resolve);
    });

    // 7. Cleanup temp files
    try {
      unlinkSync(routesFile);
    } catch {}
    try {
      unlinkSync(outputFile);
    } catch {}

    // 8. Update job status based on exit code
    if (exitCode === 0) {
      // Atomic swap: ssg-new → ssg
      await atomicSwap();
      console.log(`Job ${jobId} completed successfully`);
      await setJobStatus(jobId, 'Completed');
    } else {
      // Cleanup failed build
      await cleanupFailedBuild();
      console.error(`Job ${jobId} failed with exit code ${exitCode}`);
      await setJobStatus(jobId, 'Failed', `Prerender process exited with code ${exitCode}`);
    }
  } catch (error) {
    console.error(`Error processing job ${jobId}:`, error);
    await cleanupFailedBuild();
    await setJobStatus(jobId, 'Failed', error.message || String(error));
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

  // Test DB connection
  try {
    await pool.query('SELECT 1');
    console.log('Database connection OK');
  } catch (err) {
    console.error('Failed to connect to database:', err.message);
    process.exit(1);
  }

  // Main polling loop
  while (true) {
    try {
      const job = await pollForJob();

      if (job) {
        await processJob(job);
      } else {
        await sleep(POLL_INTERVAL);
      }
    } catch (error) {
      console.error('Error in main loop:', error);
      await sleep(POLL_INTERVAL);
    }
  }
}

// Handle shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down...');
  await pool.end();
  process.exit(0);
});

// Start
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
