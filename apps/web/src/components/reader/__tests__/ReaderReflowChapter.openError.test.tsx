import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act, within } from '@testing-library/react'
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
    }, [chapterSlug, html])
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
  onRetry: async () => true,
}
const tryAgain = () => within(screen.getByRole('alert')).getByRole('button') as HTMLButtonElement

describe('ReaderReflowChapter: the engine cannot open the chapter', () => {
  afterEach(() => { cleanup(); opens.length = 0; failNext = true })

  it('openFails_ShowsTheMessageInTheReader_WithPrevAndNext', () => {
    render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    expect(screen.getByRole('alert').textContent).toContain('reader.openError.message')
    expect(screen.queryByTestId('chapter')).toBeNull()
    expect(screen.getByLabelText('Previous chapter')).toBeTruthy()
    expect(screen.getByLabelText('Next chapter')).toBeTruthy()
  })

  it('tryAgain_TheRefetchedChapterOpens_AndTheErrorGoes', async () => {
    const { rerender } = render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    failNext = false
    // The loader swaps in the network's chapter, then resolves.
    const onRetry = vi.fn(async () => { rerender(<ReaderReflowChapter chapter={chapter('a', '<p>fresh</p>')} {...props} onRetry={onRetry} />); return true })
    rerender(<ReaderReflowChapter chapter={chapter('a')} {...props} onRetry={onRetry} />)
    await act(async () => { fireEvent.click(tryAgain()) })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(opens).toEqual(['a <p>x</p>', 'a <p>fresh</p>'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('tryAgain_TheSameHtmlFromTheNetwork_StillOpensAgain', async () => {
    render(<ReaderReflowChapter chapter={chapter('a')} {...props} />)
    failNext = false
    await act(async () => { fireEvent.click(tryAgain()) })
    expect(opens).toEqual(['a <p>x</p>', 'a <p>x</p>'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('tryAgain_DisabledWhileTheRetryRuns_AFailedRetrySaysSo', async () => {
    let done!: (landed: boolean) => void
    const onRetry = vi.fn(() => new Promise<boolean>((r) => { done = r }))
    render(<ReaderReflowChapter chapter={chapter('a')} {...props} onRetry={onRetry} />)
    fireEvent.click(tryAgain())
    expect(tryAgain().textContent).toBe('reader.openError.opening')
    expect(tryAgain().disabled).toBe(true)
    await act(async () => { done(false) })
    expect(tryAgain().textContent).toBe('reader.openError.retry')
    expect(tryAgain().disabled).toBe(false)
    expect(screen.getByText('reader.openError.stillFailing')).toBeTruthy()
    expect(opens).toEqual(['a <p>x</p>'])   // nothing re-opened
  })

  it('tryAgain_ARetryThatThrows_StillEnablesTheButton', async () => {
    const onRetry = vi.fn(async (): Promise<boolean> => { throw new Error('boom') })
    render(<ReaderReflowChapter chapter={chapter('a')} {...props} onRetry={onRetry} />)
    await act(async () => { fireEvent.click(tryAgain()) })
    expect(tryAgain().disabled).toBe(false)
    expect(screen.getByText('reader.openError.stillFailing')).toBeTruthy()
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
