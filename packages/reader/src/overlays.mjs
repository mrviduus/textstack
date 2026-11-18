// What the page asked foliate to draw over a range, keyed by that range's CFI.
//
// foliate keys an overlay by the annotation's value and removes that key before drawing it again, so a
// highlight and the translation of a word covering the very same range cannot be two overlays: adding
// the second erased the first. They are one overlay carrying both decorations instead.
export const mergeOverlay = (prev, patch) => ({ ...prev, ...patch })
