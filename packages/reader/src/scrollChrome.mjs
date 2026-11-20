/** Untrusted page scroll position. Section changes start a new baseline, never a backwards gesture. */
export function readReaderScroll(m) {
  return m?.type === 'reader-scroll' && Number.isInteger(m.section) && m.section >= 0
    && Number.isFinite(m.offset) && m.offset >= 0 && m.offset <= 1e9
    ? { section: m.section, offset: m.offset } : null
}

/** Accumulate intentional movement, ignoring small reversals from finger jitter. */
export function createScrollIntent(threshold = 24) {
  let previous = null
  let distance = 0
  return {
    reset() { previous = null; distance = 0 },
    move(next, suppressed = false) {
      const delta = previous?.section === next.section ? next.offset - previous.offset : 0
      previous = next
      // Keep the actual landing as baseline, but never interpret navigation or selection as a gesture.
      if (suppressed) { distance = 0; return null }
      if (!delta) { distance = 0; return null }
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0
      distance += delta
      if (Math.abs(distance) < threshold) return null
      const action = distance < 0 ? 'show' : 'hide'
      distance = 0
      return action
    },
  }
}
