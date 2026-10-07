/**
 * The job half of SSG, run inside ssg-worker.mjs: deciding whether a finished build may replace the
 * live tree, and keeping the worker itself alive and bounded.
 *
 * Its own module so the tests can drive it; ssg-worker.mjs connects to the database and starts
 * polling the moment it is imported.
 */

import pg from 'pg';
import { readdirSync } from 'fs';
import { join } from 'path';

/** The worker's connection pool. */
export function createPool(connectionString) {
  return new pg.Pool({ connectionString });
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

/** Resolves with the child's exit code once it has exited and its output is drained. */
export function waitForExit(proc) {
  return new Promise((resolve) => proc.on('close', (code) => resolve({ code })));
}

/** Pages actually written under `dir`, counted as index.html files. */
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
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name === 'index.html') n++;
    }
  };
  walk(dir);
  return n;
}

const MIN_RATIO = 0.9;

/** The fewest pages a build of `expectedRoutes` routes must hold to be promoted. */
export function survivalFloor(expectedRoutes) {
  return Math.floor(expectedRoutes * MIN_RATIO);
}

/**
 * Refuse to promote a build that lost most of itself between rendering and swapping.
 *
 * The floor is deliberately loose: routes legitimately go unwritten when a page renders
 * noindex (a draft book, a not-found), so a healthy build lands a little short of its
 * route count. It is not trying to catch a handful of missing pages — it is there for the
 * case where the directory is gone, which is not subtle: on 2026-08-31 a build reported
 * 1990 of 1992 rendered and had 127 files left on disk.
 */
export function assertBuildSurvived(dir, expectedRoutes) {
  const found = countRenderedPages(dir);
  const floor = survivalFloor(expectedRoutes);
  if (found < floor) {
    throw new Error(
      `Refusing atomic swap: ${dir} holds ${found} pages, expected at least ${floor} ` +
      `of ${expectedRoutes} routes. Something removed the build while it ran (a concurrent ` +
      `deploy wipes apps/web/dist). Keeping the current SSG tree.`
    );
  }
  console.log(`Build survived: ${found} pages on disk (floor ${floor} of ${expectedRoutes})`);
}
