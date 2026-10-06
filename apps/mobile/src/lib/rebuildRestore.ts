import type { TextPosition } from '@textstack/shared'

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
  | { kind: 'percent'; percent: number }
  | null

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
  return `window.__textstackRestorePercent && window.__textstackRestorePercent(${target.percent}, ${restoreId})`
}
