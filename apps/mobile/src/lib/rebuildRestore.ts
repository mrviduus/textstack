import type { TextPosition } from '@textstack/shared'
import type { RestoreGateState } from './readerWriteGate'

/**
 * Where a REBUILT document of the chapter already open goes back to — a font-face
 * change (L1) or a renderer that died and was remounted (M6).
 *
 * This used to be the chapter percent, read when the new document finished
 * loading. Two things were wrong with that. A percent is the one coordinate a
 * reflow does not preserve (a new face changes every line's height), while the
 * text anchor of ADR-015 is exactly the one that does. And by the time the new
 * document has loaded, its own load-event progress message may already have
 * zeroed the live percent — so the snapshot is taken when the rebuild STARTS.
 */
export type RebuildTarget =
  | { kind: 'anchor'; position: TextPosition }
  | { kind: 'offset'; offset: number }
  | { kind: 'percent'; percent: number }
  | null

/** The open restore's target from the saved record: anchor → offset → percent. Null: nothing saved. */
export function savedRestoreTarget(saved: { position: TextPosition | null; offset: number | null; percent: number | null }): RebuildTarget {
  if (saved.position != null) return { kind: 'anchor', position: saved.position }
  if (saved.offset != null) return { kind: 'offset', offset: saved.offset }
  if (saved.percent != null) return { kind: 'percent', percent: saved.percent }
  return null
}

/**
 * ADR-019 rule 8: a rebuild or reflow during a restore keeps the pending target.
 *
 * Until a restore lands, the live refs hold the load event's values (percent 0, no position), so a
 * snapshot of them is "the top". Reader settings load after the first render, which makes a rebuild
 * (OpenDyslexic) or a reflow (font size) during the open restore the normal case, not an edge.
 *
 * - `keepPending`: a restore is in flight — its target is still where the reader is going.
 * - `snapshot`: it landed (or there was none) — the live refs are where the reader is.
 * - `awaitRestore`: the open restore has not fired — it will, on the new document, with its own target.
 *
 * `pendingTarget` is undefined when nothing is in flight; null is a pending "top of the chapter".
 */
export function pendingRestoreTarget(o: {
  /** A rebuild's target not yet consumed by its document's load. */
  rebuildTarget: RebuildTarget | undefined
  /** The newest restore issued, with its target. */
  pending: { restoreId: number; target: RebuildTarget } | null
  gate: RestoreGateState
  currentId: number
}): RebuildTarget | undefined {
  // A second rebuild before the first one's document loaded keeps the first one's target — the
  // gate is 'awaiting' then, which says nothing about whether an older restore is in flight.
  if (o.rebuildTarget !== undefined) return o.rebuildTarget
  const p = o.pending
  if (!p || p.restoreId !== o.currentId) return undefined  // a reflow (newer id) took over
  return o.gate.phase === 'issued' && o.gate.restoreId === p.restoreId ? p.target : undefined
}

/**
 * The "moved since?" baseline after an ack. Only a restore that moved the reader somewhere new
 * sets it — the open restore and a newer-position move, which both clear it first. A reflow or a
 * rebuild re-landing puts the reader back where they were and must not hide that they had moved.
 */
export function landingBaseline(baseline: number | null, ackScrollY: number | undefined): number | null {
  return baseline ?? (typeof ackScrollY === 'number' ? ackScrollY : null)
}

export type DuringRestorePlan =
  | { kind: 'keepPending'; target: RebuildTarget }
  | { kind: 'snapshot'; target: RebuildTarget }
  | { kind: 'awaitRestore' }

export function duringRestorePlan(o: {
  restoreFired: boolean
  pendingTarget: RebuildTarget | undefined
  live: RebuildTarget
}): DuringRestorePlan {
  if (!o.restoreFired) return { kind: 'awaitRestore' }
  if (o.pendingTarget !== undefined) return { kind: 'keepPending', target: o.pendingTarget }
  return { kind: 'snapshot', target: o.live }
}

export function rebuildRestoreTarget(
  position: TextPosition | null,
  percent: number,
  chapterSlug: string | null | undefined,
): RebuildTarget {
  if (position && position.chapterSlug === chapterSlug) return { kind: 'anchor', position }
  if (Number.isFinite(percent) && percent > 0.001) return { kind: 'percent', percent }
  return null
}

/** The injection for a target, under its restore id. Null: top of the chapter, nothing to ask. */
export function rebuildRestoreJs(target: RebuildTarget, restoreId: number): string | null {
  if (!target) return null
  if (target.kind === 'anchor') {
    return `window.__textstackRestoreAnchor && window.__textstackRestoreAnchor(${JSON.stringify(JSON.stringify(target.position))}, ${restoreId})`
  }
  if (target.kind === 'offset') {
    return `window.__textstackRestoreScroll && window.__textstackRestoreScroll(${target.offset}, ${restoreId})`
  }
  return `window.__textstackRestorePercent && window.__textstackRestorePercent(${target.percent}, ${restoreId})`
}
