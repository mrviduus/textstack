/**
 * The job half of SSG, run inside ssg-worker.mjs: deciding whether a finished build may replace the
 * live tree, and keeping the worker itself alive and bounded.
 *
 * Its own module so the tests can drive it; ssg-worker.mjs connects to the database and starts
 * polling the moment it is imported.
 */

import pg from 'pg';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, sep } from 'path';
import { NOINDEX_SKIP } from './ssgRender.mjs';

/**
 * The worker's connection pool, with `onError` listening for idle-client failures.
 *
 * When the database restarts, pg emits 'error' on the pool for each idle client whose connection
 * died. An EventEmitter with no 'error' listener throws, so the worker crashed (compose restarted
 * it, mid-job if there was one). Listening is enough: pg has already dropped the client, and the
 * next query opens a fresh connection.
 */
export function createPool(connectionString, onError) {
  const pool = new pg.Pool({ connectionString });
  pool.on('error', onError);
  return pool;
}

/**
 * Reports an error unless it is the one reported last; `recovered()` forgets it. So a persistent
 * failure (the database gone, a renamed column) is one event rather than one every poll, and the
 * next outage is reported again.
 */
export function reportOncePerOutage(report) {
  let last = null;
  return {
    report(error) {
      if (String(error) === last) return;
      last = String(error);
      report(error);
    },
    recovered() {
      last = null;
    },
  };
}

/** What a Running row nobody is rendering is closed with. */
export const INTERRUPTED_ERROR = 'interrupted (not owned by the running ssg-worker)';

/**
 * Recovery (ADR-022), run before every claim. ssg-worker is the queue's only consumer and runs one job
 * at a time, so between jobs nothing of ours is Running: any such row is dead. It was left by a
 * previous worker (crash, restart mid-render), by this one when the database dropped mid-job and both
 * status writes failed, or by a claim whose UPDATE committed but whose reply was lost. Without this,
 * one such row stays Running for good and every later enqueue is skipped as a duplicate. Failed, not
 * re-queued: a job that kills the worker would otherwise kill it again. Returns the ids it closed.
 */
export async function failInterruptedJobs(pool) {
  const { rows } = await pool.query(
    `UPDATE ssg_rebuild_jobs
        SET status = 'Failed', error = $1, finished_at = now()
      WHERE status = 'Running'
      RETURNING id`,
    [INTERRUPTED_ERROR],
  );
  return rows.map((r) => r.id);
}

/**
 * Claims the oldest Queued job (ADR-022): Queued -> Running in one statement, so the API's enqueue is a
 * single insert and "Running" only ever means "ssg-worker is rendering it". SKIP LOCKED keeps a
 * concurrent claimer (there should be none) off the same row. Null when nothing is queued.
 */
export async function claimNextJob(pool) {
  const { rows } = await pool.query(`
    WITH claimed AS (
      UPDATE ssg_rebuild_jobs
         SET status = 'Running', started_at = now()
       WHERE id = (
         SELECT id FROM ssg_rebuild_jobs
          WHERE status = 'Queued'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, site_id, mode, concurrency, timeout_ms
    )
    SELECT c.*, s.code AS site_code, s.primary_domain
      FROM claimed c
      JOIN sites s ON c.site_id = s.id
  `);
  return rows[0] || null;
}

/**
 * One main-loop step: fail dead Running rows, then claim the oldest Queued job. Both before the job
 * starts, so the sweep can never hit the job this iteration is about to render.
 */
export async function nextJob(pool) {
  const interrupted = await failInterruptedJobs(pool);
  const job = await claimNextJob(pool);
  return { interrupted, job };
}

const MINUTE = 60_000;

/** A positive number of ms from the environment, else `fallback` (setTimeout reads NaN as 1 ms). */
function positiveMs(value, fallback) {
  const n = Number(value);
  return n > 0 ? n : fallback;
}

/**
 * How long a rebuild may run. `stallMs`: the longest it may go without progress (isProgress), 5 min.
 * `deadlineMs`: a cap for a job that keeps moving but never ends — max(60 min, 2 s per route), so it
 * grows with the library instead of one day stopping every rebuild of a bigger one.
 */
export function jobLimits(routeCount, env = process.env) {
  return {
    stallMs: positiveMs(env.SSG_JOB_STALL_MS, 5 * MINUTE),
    deadlineMs: positiveMs(env.SSG_JOB_DEADLINE_MS, Math.max(60 * MINUTE, routeCount * 2000)),
  };
}

/**
 * Whether a prerender event shows the job moving. A route that rendered or was skipped counts, and
 * so does any attempt in a retry pass. A failure in the first pass does not: a hung API still
 * completes every route — as a failure, at the 30 s navigation timeout — and counting those kept a
 * hung job alive to the cap. A retry pass is all failures by construction, so there every attempt
 * counts, or a few persistently broken routes would stall a good build.
 */
export function isProgress(event) {
  if (event?.event !== 'result') return false;
  return event.success === true || event.error === NOINDEX_SKIP || event.retry > 0;
}

/**
 * Watches a child: stops it when it goes `stallMs` without `progress()`, or at `deadlineMs`.
 * `exited` resolves with { code, signal, stopped: null | 'stalled' | 'deadline' }.
 *
 * SIGINT first: prerender's Chrome runs in a process group of its own, which only puppeteer knows
 * how to kill, and puppeteer does that (then exits) on SIGINT. SIGKILL after `graceMs` if that did
 * not end it.
 */
export function superviseChild(proc, { stallMs, deadlineMs, graceMs = 10_000 }) {
  let stopped = null;
  let killTimer;
  let stallTimer;
  const stop = (reason) => {
    if (stopped) return;
    stopped = reason;
    clearTimeout(stallTimer);
    clearTimeout(deadline);
    proc.kill('SIGINT');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), graceMs);
  };
  const deadline = setTimeout(() => stop('deadline'), deadlineMs);
  stallTimer = setTimeout(() => stop('stalled'), stallMs);

  const exited = new Promise((resolve) => {
    proc.on('close', (code, signal) => {
      clearTimeout(stallTimer);
      clearTimeout(deadline);
      clearTimeout(killTimer);
      resolve({ code, signal, stopped });
    });
  });

  return {
    exited,
    progress() {
      if (stopped) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => stop('stalled'), stallMs);
    },
  };
}

/** Pages actually written under `dir`: index.html files that are files and not empty. */
export function countRenderedPages(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name === 'index.html' && e.isFile() && statSync(path).size > 0) n++;
    }
  };
  walk(dir);
  return n;
}

const MIN_RATIO = 0.9;

/**
 * The fewest pages a build of `expectedRoutes` routes must hold to be promoted: 90 %, and never
 * zero when there was anything to render — floor(1 * 0.9) is 0, which promoted an empty build.
 */
export function survivalFloor(expectedRoutes) {
  if (expectedRoutes <= 0) return 0;
  return Math.max(1, Math.floor(expectedRoutes * MIN_RATIO));
}

/**
 * Refuse to promote a build that lost most of itself between rendering and swapping, or that
 * failed to render most of its pages.
 *
 * Count before carryForwardFailedPages: a failed render writes no file, so too many failures
 * land below the floor and the build is refused, whatever could have been carried over.
 *
 * The floor is deliberately loose: routes legitimately go unwritten when a page renders
 * noindex (a draft book, a not-found), so a healthy build lands a little short of its
 * route count. It is not trying to catch a handful of missing pages — it is there for the
 * case where the directory is gone, which is not subtle: on 2026-08-31 a build reported
 * 1990 of 1992 rendered and had 127 files left on disk — or the API is.
 */
export function assertBuildSurvived(dir, expectedRoutes) {
  const found = countRenderedPages(dir);
  const floor = survivalFloor(expectedRoutes);
  if (found < floor) {
    throw new Error(
      `Refusing atomic swap: ${dir} holds ${found} pages, expected at least ${floor} ` +
      `of ${expectedRoutes} routes. Either most routes failed to render (is the API answering?) ` +
      `or something removed the build while it ran (a concurrent deploy wipes apps/web/dist). ` +
      `Keeping the current SSG tree.`
    );
  }
  console.log(`Build survived: ${found} pages on disk (floor ${floor} of ${expectedRoutes})`);
}

/** prerender's results file: one entry per route. Throws when it is missing or not a list. */
export function readResults(file) {
  let results;
  try {
    results = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`prerender results ${file} unreadable: ${err.message}`);
  }
  if (!Array.isArray(results)) throw new Error(`prerender results ${file} is not a list`);
  return results;
}

/**
 * Copies the live page of every route that failed to render into the new build, so the swap keeps
 * it. The worker replaces the whole tree, so a route missing from the new build disappears from
 * the site — a crawler gets a 404 where it had a page — because one render went wrong.
 *
 * Not for a noindex skip, which is deliberate: that page has left the index. Never over a page
 * rendered this time. Returns the routes it carried.
 */
export function carryForwardFailedPages(results, liveDir, newDir) {
  const carried = [];
  for (const r of results) {
    if (r?.success !== false || r.error === NOINDEX_SKIP) continue;
    const file = join(String(r.route ?? ''), 'index.html');
    const from = join(liveDir, file);
    const to = join(newDir, file);
    if (!from.startsWith(liveDir + sep) || !to.startsWith(newDir + sep)) continue;
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    carried.push(r.route);
  }
  return carried;
}
