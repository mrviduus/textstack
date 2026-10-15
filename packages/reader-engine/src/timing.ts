// The engine's gesture timings, apart from the DOM code so a host's tests can wait on them.

/** iOS fires `selectionchange` all through a drag: a selection is sent once it stops changing. */
export const SELECTION_SETTLE_MS = 220
/** A deliberate hold, not a brush; moving this far makes it a scroll. */
export const HOLD_MS = 450
