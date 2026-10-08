import { describe, it, expect } from 'vitest'
import { extractSentence } from './sentenceExtractor'

function setup(html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

function rangeOver(text: Text, start: number, end: number): Range {
  const r = document.createRange()
  r.setStart(text, start)
  r.setEnd(text, end)
  return r
}

const TWO_WOUNDS = '<p>The wound bled. Later she wound the clock.</p>'

describe('extractSentence', () => {
  it('extractSentence_SecondOccurrenceTapped_ReturnsSecondSentence', () => {
    const container = setup(TWO_WOUNDS)
    const text = container.querySelector('p')!.firstChild as Text
    const at = text.data.lastIndexOf('wound')

    expect(extractSentence(rangeOver(text, at, at + 5), container)).toBe('Later she wound the clock.')
  })

  it('extractSentence_FirstOccurrenceTapped_ReturnsFirstSentence', () => {
    const container = setup(TWO_WOUNDS)
    const text = container.querySelector('p')!.firstChild as Text
    const at = text.data.indexOf('wound')

    expect(extractSentence(rangeOver(text, at, at + 5), container)).toBe('The wound bled.')
  })

  it('extractSentence_WordInLaterInlineNode_UsesOffsetWithinBlock', () => {
    const container = setup('<p>The wound bled. Later <em>she wound</em> the clock.</p>')
    const em = container.querySelector('em')!.firstChild as Text
    const at = em.data.indexOf('wound')

    expect(extractSentence(rangeOver(em, at, at + 5), container)).toBe('Later she wound the clock.')
  })

  it('extractSentence_SelectionWithLeadingSpace_StillFindsTappedWord', () => {
    const container = setup(TWO_WOUNDS)
    const text = container.querySelector('p')!.firstChild as Text
    const at = text.data.lastIndexOf(' wound')

    expect(extractSentence(rangeOver(text, at, at + 6), container)).toBe('Later she wound the clock.')
  })
})
