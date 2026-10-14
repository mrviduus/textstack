import type { HighlightColor } from '../../lib/offlineDb'

// The fills the engine paints (reflow and PDF). CSS-var-driven: reader.css overrides them per theme.

export const COLOR_MAP: Record<HighlightColor, string> = {
  yellow: 'var(--reader-overlay-hl-yellow, rgba(254, 240, 138, 0.5))',
  green: 'var(--reader-overlay-hl-green, rgba(187, 247, 208, 0.5))',
  pink: 'var(--reader-overlay-hl-pink, rgba(251, 207, 232, 0.5))',
  blue: 'var(--reader-overlay-hl-blue, rgba(191, 219, 254, 0.5))',
}

/** Saved words by SRS stage. */
export const COLOR_PER_STAGE: Record<number, string> = {
  0: 'var(--reader-overlay-vocab-stage0, rgba(59, 130, 246, 0.5))',
  1: 'var(--reader-overlay-vocab-stage1, rgba(234, 179, 8, 0.5))',
  2: 'var(--reader-overlay-vocab-stage2, rgba(234, 179, 8, 0.4))',
  3: 'var(--reader-overlay-vocab-stage3, rgba(34, 197, 94, 0.4))',
  4: 'var(--reader-overlay-vocab-stage4, rgba(34, 197, 94, 0.25))',
}
/** The word in the open popup. */
export const ACTIVE_COLOR = 'var(--reader-overlay-vocab-active, rgba(59, 130, 246, 0.7))'

/** A search hit that is not the current one. */
export const INACTIVE_COLOR = 'var(--reader-overlay-search-inactive, rgba(250, 204, 21, 0.35))'
