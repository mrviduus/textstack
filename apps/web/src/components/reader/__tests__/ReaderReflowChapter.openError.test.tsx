import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { useEffect } from 'react'
import type { ReaderSettings } from '../../../hooks/useReaderSettings'

// #849: a chapter the engine cannot open says so inside the reader: the chapter nav stays, Try again re-opens.
const opens: string[] = []
let failNext = true
vi.mock('../ReaderSection', () => ({
  ReaderSection: ({ chapterSlug, html, onEngineError, onEngineOpened }: { chapterSlug: string; html: string; onEngineError: (s: string) => void; onEngineOpened: (s: string) => void }) => {
    useEffect(() => {
      opens.push(`${chapterSlug} ${html}`)
      if (failNext) onEngineError(chapterSlug)
      else onEngineOpened(chapterSlug)
    }, [chapterSlug])
    return <article data-testid="chapter" />
  },
}))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { ReaderReflowChapter } from '../ReaderReflowChapter'

const chapter = (id: string, html = '<p>x</p>') => ({
  id, chapterNumber: 1, identifier: id, title: `Chapter ${id}`, html, wordCount: null,
  prev: { identifier: 'prev', title: 'Prev' }, next: { identifier: 'next', title: 'Next' },
})
const props = {
  settings: {} as ReaderSettings, onTap: () => {}, onEngineOpened: () => {}, discuss: null,
  chapterNumber: 2, totalChapters: 3, chapterProgress: 0, onGoTo: () => {}, onFinish: () => {}, finishLabel: 'Finish',
  onReload: () => {}, loadId: 1,
}

describe('ReaderReflowChapter: the engine cannot open the chapter', () => {
  afterEach(() => { cleanup(); opens.length = 0; failNext = true })

  it('openFails_ShowsTheMessageInTheReader_WithPrevAndNext', () => {
    render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain('reader.openError.message')
    expect(screen.queryByTestId('chapter')).toBeNull()
    expect(screen.getByLabelText('Previous chapter')).toBeTruthy()
    expect(screen.getByLabelText('Next chapter')).toBeTruthy()
  })

  it('tryAgain_RefetchesTheChapter_ThenOpensTheNewHtml_AndClearsTheError', () => {
    const onReload = vi.fn()
    const { rerender } = render(<ReaderReflowChapter chapter={chapter('a')} {...props} onReload={onReload} />)
    failNext = false
    fireEvent.click(screen.getByText('reader.openError.retry'))
    expect(onReload).toHaveBeenCalledTimes(1)
    rerender(<ReaderReflowChapter chapter={chapter('a')} {...props} onReload={onReload} />)   // a re-render: no new load
    expect(screen.getByRole('alert')).toBeTruthy()   // until the network's chapter lands
    rerender(<ReaderReflowChapter chapter={chapter('a', '<p>fresh</p>')} {...props} onReload={onReload} loadId={2} />)
    expect(opens).toEqual(['a <p>x</p>', 'a <p>fresh</p>'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('chapter')).toBeTruthy()
  })

  it('tryAgain_SameHtmlFromTheNetwork_StillOpensAgain', () => {
    const { rerender } = render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    failNext = false
    rerender(<ReaderReflowChapter chapter={chapter('a')} {...props} loadId={2} />)
    expect(opens).toEqual(['a <p>x</p>', 'a <p>x</p>'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('failOnA_GoToB_ReturnToA_AOpensAgain', () => {
    const { rerender } = render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    failNext = false
    rerender(<ReaderReflowChapter chapter={chapter('b')} {...props} />)
    rerender(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    expect(opens).toEqual(['a <p>x</p>', 'b <p>x</p>', 'a <p>x</p>'])
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
