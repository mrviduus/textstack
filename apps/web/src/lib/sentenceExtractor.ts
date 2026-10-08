/**
 * Extract the sentence containing the selected text from the surrounding DOM.
 * Walks backward/forward from the selection range to find sentence boundaries.
 */
export function extractSentence(range: Range, container: HTMLElement): string {
  const node = range.startContainer
  if (!node.textContent) return ''

  // Get the full text of the paragraph/block containing the selection
  const block = findBlockParent(node, container)
  const fullText = block?.textContent || node.textContent || ''

  // TR-1: locate the TAPPED occurrence by its offset in the block, not by indexOf
  // (which finds the first one). Falls back to indexOf if the offset does not line up.
  const raw = range.toString()
  const selectedText = raw.trim()
  const before = document.createRange()
  before.setStart(block ?? node, 0)
  before.setEnd(range.startContainer, range.startOffset)
  let idx = before.toString().length + raw.length - raw.trimStart().length
  if (fullText.slice(idx, idx + selectedText.length) !== selectedText) idx = fullText.indexOf(selectedText)
  if (idx < 0) return fullText.slice(0, 200)

  // Walk backward to find sentence start
  const sentenceEnders = /[.!?\n]/
  let start = idx
  while (start > 0) {
    const ch = fullText[start - 1]
    if (sentenceEnders.test(ch)) break
    start--
  }

  // Walk forward to find sentence end
  let end = idx + selectedText.length
  while (end < fullText.length) {
    const ch = fullText[end]
    if (sentenceEnders.test(ch)) {
      end++ // include the punctuation
      break
    }
    end++
  }

  const sentence = fullText.slice(start, end).trim()

  // Cap at 200 chars
  if (sentence.length > 200) {
    // Try to center the word
    const wordStart = idx - start
    const cropStart = Math.max(0, wordStart - 80)
    const cropEnd = Math.min(sentence.length, cropStart + 200)
    return (cropStart > 0 ? '...' : '') + sentence.slice(cropStart, cropEnd) + (cropEnd < sentence.length ? '...' : '')
  }

  return sentence
}

function findBlockParent(node: Node, container: HTMLElement): HTMLElement | null {
  let current: Node | null = node
  const blockTags = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

  while (current && current !== container) {
    if (current instanceof HTMLElement && blockTags.has(current.tagName)) {
      return current
    }
    current = current.parentNode
  }
  return null
}
