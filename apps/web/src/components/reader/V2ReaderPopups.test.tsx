import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Popup } from '../../../../mobile/src/lib/v2reader/wordPopup.mjs'
import { V2ReaderPopups } from './V2ReaderPopups'

// #1269 review: what WordPopup is rendered with, render by render (the first frame of a new word included).

const renders: { word: string; translation: string | null; translationLoading: boolean }[] = []
vi.mock('./WordPopup', () => ({
  WordPopup: (p: { word: string; translation: string | null; translationLoading: boolean }) => {
    renders.push({ word: p.word, translation: p.translation, translationLoading: p.translationLoading })
    return null
  },
}))
const answers: Record<string, (v: unknown) => void> = {}
vi.mock('../../api/translation', () => ({
  translate: (text: string) => new Promise((r) => { answers[text] = r }),
  getLanguages: async () => [],
}))

afterEach(cleanup)

const word = (w: string): V2Popup => ({ kind: 'word', index: 0, word: w, sentence: `The ${w}.`, cfi: null, rect: { x: 400, y: 100, w: 30, h: 10 } })

describe('V2ReaderPopups word popup', () => {
  it('aNewWord_NeverRenderedWithThePreviousWordsGloss', async () => {
    const frame = createRef<HTMLIFrameElement>()
    const props = { frame, bookLanguage: 'de', onClose: () => {} }
    const view = render(<V2ReaderPopups {...props} popup={word('Teich')} />)
    await act(async () => { answers.Teich({ translatedText: 'pond' }) })
    expect(renders[renders.length - 1]).toEqual({ word: 'Teich', translation: 'pond', translationLoading: false })
    const from = renders.length
    view.rerender(<V2ReaderPopups {...props} popup={word('Wald')} />)
    const wald = renders.slice(from).filter((r) => r.word === 'Wald')
    expect(wald.length).toBeGreaterThan(0)
    // From its first frame: loading, never "pond".
    expect(wald.every((r) => r.translation === null && r.translationLoading)).toBe(true)
  })
})
