import type { TextAnchor } from './offlineDb'

const CONTEXT_LENGTH = 30

/**
 * Create a TextAnchor from a Range in the DOM
 */
export function createTextAnchor(
  range: Range,
  chapterId: string,
  container: HTMLElement
): TextAnchor {
  const exact = range.toString()

  // Get text content before/after selection within the container
  const beforeRange = document.createRange()
  beforeRange.setStart(container, 0)
  beforeRange.setEnd(range.startContainer, range.startOffset)
  const beforeText = beforeRange.toString()

  const afterRange = document.createRange()
  afterRange.setStart(range.endContainer, range.endOffset)
  afterRange.setEndAfter(container)
  const afterText = afterRange.toString()

  const prefix = beforeText.slice(-CONTEXT_LENGTH)
  const suffix = afterText.slice(0, CONTEXT_LENGTH)

  // Calculate offsets relative to container's text
  const startOffset = beforeText.length
  const endOffset = startOffset + exact.length

  return {
    prefix,
    exact,
    suffix,
    startOffset,
    endOffset,
    chapterId,
  }
}

/**
 * Find text in container using the anchor
 * Returns a Range if found, null otherwise
 */
export function findTextByAnchor(
  anchor: TextAnchor,
  container: HTMLElement
): Range | null {
  const fullText = container.textContent || ''

  // Strategy 1: Try exact match with context
  const contextMatch = findWithContext(fullText, anchor)
  if (contextMatch !== null) {
    return createRangeAtOffset(container, contextMatch, anchor.exact.length)
  }

  // Strategy 2: Fallback to offsets
  if (anchor.startOffset >= 0 && anchor.endOffset <= fullText.length) {
    const offsetText = fullText.slice(anchor.startOffset, anchor.endOffset)
    // Verify it's still the same text (or close enough)
    if (offsetText === anchor.exact || similarity(offsetText, anchor.exact) > 0.8) {
      return createRangeAtOffset(container, anchor.startOffset, anchor.exact.length)
    }
  }

  // Strategy 3: Fuzzy match
  const fuzzyMatch = findFuzzyMatch(fullText, anchor.exact)
  if (fuzzyMatch !== null) {
    return createRangeAtOffset(container, fuzzyMatch, anchor.exact.length)
  }

  return null
}

function findWithContext(fullText: string, anchor: TextAnchor): number | null {
  // Build search pattern: prefix + exact + suffix
  const searchPattern = anchor.prefix + anchor.exact + anchor.suffix

  let index = fullText.indexOf(searchPattern)
  if (index !== -1) {
    return index + anchor.prefix.length
  }

  // Try just prefix + exact
  const prefixExact = anchor.prefix + anchor.exact
  index = fullText.indexOf(prefixExact)
  if (index !== -1) {
    return index + anchor.prefix.length
  }

  // Try just exact + suffix
  const exactSuffix = anchor.exact + anchor.suffix
  index = fullText.indexOf(exactSuffix)
  if (index !== -1) {
    return index
  }

  // Try exact text alone
  index = fullText.indexOf(anchor.exact)
  if (index !== -1) {
    // Verify by checking if context matches
    const foundPrefix = fullText.slice(Math.max(0, index - CONTEXT_LENGTH), index)
    const foundSuffix = fullText.slice(index + anchor.exact.length, index + anchor.exact.length + CONTEXT_LENGTH)

    if (similarity(foundPrefix, anchor.prefix) > 0.5 || similarity(foundSuffix, anchor.suffix) > 0.5) {
      return index
    }

    // If multiple matches, find best one
    let bestIndex = index
    let bestScore = similarity(foundPrefix, anchor.prefix) + similarity(foundSuffix, anchor.suffix)

    let searchFrom = index + 1
    while ((index = fullText.indexOf(anchor.exact, searchFrom)) !== -1) {
      const prefix = fullText.slice(Math.max(0, index - CONTEXT_LENGTH), index)
      const suffix = fullText.slice(index + anchor.exact.length, index + anchor.exact.length + CONTEXT_LENGTH)
      const score = similarity(prefix, anchor.prefix) + similarity(suffix, anchor.suffix)

      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
      searchFrom = index + 1
    }

    return bestIndex
  }

  return null
}

function findFuzzyMatch(fullText: string, exact: string): number | null {
  // For short texts, try sliding window
  if (exact.length < 100) {
    let bestIndex = -1
    let bestScore = 0.6 // minimum threshold

    for (let i = 0; i <= fullText.length - exact.length; i++) {
      const candidate = fullText.slice(i, i + exact.length)
      const score = similarity(candidate, exact)
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }

    if (bestIndex !== -1) {
      return bestIndex
    }
  }

  return null
}

/**
 * Create a Range at a specific text offset in container
 */
function createRangeAtOffset(
  container: HTMLElement,
  startOffset: number,
  length: number
): Range | null {
  const range = document.createRange()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)

  let currentOffset = 0
  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const nodeLength = node.length

    // Find start node
    if (startNode === null && currentOffset + nodeLength > startOffset) {
      startNode = node
      startNodeOffset = startOffset - currentOffset
    }

    // Find end node
    if (startNode !== null && currentOffset + nodeLength >= startOffset + length) {
      endNode = node
      endNodeOffset = startOffset + length - currentOffset
      break
    }

    currentOffset += nodeLength
  }

  if (startNode && endNode) {
    try {
      range.setStart(startNode, startNodeOffset)
      range.setEnd(endNode, endNodeOffset)
      return range
    } catch {
      return null
    }
  }

  return null
}

/**
 * Simple string similarity (Dice coefficient)
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2))
    }
    return set
  }

  const aBigrams = bigrams(a.toLowerCase())
  const bBigrams = bigrams(b.toLowerCase())

  let intersection = 0
  for (const bg of aBigrams) {
    if (bBigrams.has(bg)) intersection++
  }

  return (2 * intersection) / (aBigrams.size + bBigrams.size)
}

/**
 * Get the bounding rectangles for a highlight anchor
 */
export function getHighlightRects(
  anchor: TextAnchor,
  container: HTMLElement
): DOMRect[] {
  const range = findTextByAnchor(anchor, container)
  if (!range) return []

  return Array.from(range.getClientRects())
}
