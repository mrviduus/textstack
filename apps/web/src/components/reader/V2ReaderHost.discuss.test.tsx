import { ApiError, CHAPTER_TEXT_MS, type V2Share, type V2ShareWrite } from '@textstack/shared'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { v2Store } from '../../api/v2'
import { __resetAssistantGrants } from '../../hooks/useAssistantLauncher'
import { v2ReaderSyncApi, type V2SyncTarget } from '../../lib/v2ReaderSync'
import { V2ReaderHost, v2DiscussApi, type V2HostBook } from './V2ReaderHost'

// #1316 in the host, the page and the server faked: the end-of-chapter block follows the page's `chapterEnd`,
// "Discuss this chapter" asks the page for that chapter's text, shares it under the book, its file and a key, and
// only then offers the chat, with the share's id. A failure is said with a retry and never hands over an id.

const listOAuthGrants = vi.fn()
vi.mock('../../api/oauth', () => ({ listOAuthGrants: () => listOAuthGrants() }))

const SHA = 'a'.repeat(64)
const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }
const SHARE = '5ba7ed00-0000-4000-8000-000000000001'
const TOC = [{ label: 'Alpha', href: 's1.xhtml#a', depth: 0 }, { label: 'Beta', href: 's1.xhtml#b', depth: 1 }, { label: 'Gamma', href: 's3.xhtml', depth: 0 }]

beforeEach(() => {
  __resetAssistantGrants()
  listOAuthGrants.mockReset().mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function reader(o: { toc?: object[]; dev?: boolean; title?: string } = {}) {
  vi.spyOn(v2ReaderSyncApi, 'getReadingState').mockResolvedValue(null)
  vi.spyOn(v2ReaderSyncApi, 'annotations').mockResolvedValue([])
  const share = vi.spyOn(v2DiscussApi, 'shareChapter').mockImplementation(async (bookId: string, body: V2ShareWrite): Promise<V2Share> =>
    ({ id: SHARE, bookId, chapterKey: body.chapterKey, createdAt: '2026-11-15T10:00:00Z' }))
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
  const host = (book: V2HostBook | null) => <MemoryRouter><V2ReaderHost book={book} dev={o.dev} /></MemoryRouter>
  const view = render(host(null))
  const frame = (screen.getByTitle('Book text') as HTMLIFrameElement).contentWindow!
  const toPage = vi.spyOn(frame, 'postMessage').mockImplementation((() => {}) as never)
  const fromPage = (m: object) => act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m), origin: location.origin, source: frame }))
    await new Promise((r) => setTimeout(r, 0))
  })
  let opens = 0
  const openBook = async (t: V2SyncTarget = T) => {
    view.rerender(host({ bytes: new ArrayBuffer(8), name: t.name, sync: o.dev ? undefined : t }))
    await fromPage({ type: 'opened', title: o.title ?? 'Dracula', author: 'Bram Stoker', lang: 'en', format: t.format, toc: o.toc ?? TOC, book: { sha256: t.sha256, size: 8, name: `${++opens}/${t.name}` } })
    await fromPage({ type: 'restored', key: t.sha256, position: 'restored' })
  }
  await fromPage({ type: 'ready' })
  await openBook()
  const relocate = (m: object) => fromPage({ type: 'relocate', cfi: 'epubcfi(/6/4!/4/2/1:0)', index: 0, sections: 3, fraction: 0.4, ...m })
  const click = (testId: string) => act(async () => {
    screen.getByTestId(testId).click()
    await new Promise((r) => setTimeout(r, 0))
  })
  /** The `chapterText` requests the host sent the page: `[request, tocIndex, section]`. */
  const asked = () => toPage.mock.calls.map(([m]) => m as { call: string; args: unknown[] }).filter((m) => m.call === 'chapterText').map((m) => m.args as [string, number | null, number])
  /** The page's answer to the host's latest request. */
  const answer = (m: object) => fromPage({ type: 'chapter-text', request: asked().slice(-1)[0][0], ...m })
  return { share, opened, relocate, click, asked, answer, openBook, fromPage }
}
const block = () => screen.queryByTestId('v2-discuss')

describe('V2ReaderHost discuss chapter (#1316)', () => {
  it('relocate_ChapterEndThenAway_BlockShownForThatEntryThenHidden_NeverGuessedFromTheEntryOrTheFraction', async () => {
    const { relocate } = await reader()
    await relocate({ tocIndex: 1, fraction: 1, atEnd: false })
    expect(block()).toBeNull()
    await relocate({ tocIndex: 2, chapterEnd: { tocIndex: 1, section: 0 } })
    expect(screen.getByRole('button', { name: 'Discuss the chapter Beta with your assistant' })).toHaveTextContent('Discuss this chapter')
    await relocate({ tocIndex: 2, chapterEnd: null })
    expect(block()).toBeNull()
  })

  it('chapterEnd_AnEntryTheHostDoesNotHold_OrMalformed_NoBlock', async () => {
    const { relocate } = await reader()
    for (const chapterEnd of [{ tocIndex: 9, section: 0 }, { tocIndex: null, section: 0 }, { tocIndex: '1', section: 0 }, { tocIndex: 1 }, 'toc-1']) {
      await relocate({ chapterEnd })
      expect(block()).toBeNull()
    }
  })

  it('devRoute_NoServerBook_NoBlock', async () => {
    const { relocate } = await reader({ dev: true })
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    expect(block()).toBeNull()
  })

  it('discuss_Clicked_ThatEntrysTextSharedUnderBookFileAndKey_ThenTheChatOpensWithTheBookAndShareIds', async () => {
    const { share, opened, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    expect(asked().map(([, tocIndex, section]) => [tocIndex, section])).toEqual([[1, 0]])
    expect(screen.getByTestId('v2-discuss-share')).toBeDisabled()
    expect(share).not.toHaveBeenCalled()
    await answer({ text: 'Beta\n\nBeta begins.', cut: false })

    expect(share.mock.calls).toEqual([['b1', { operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), fileId: 'f1', chapterKey: 'toc-1', chapterTitle: 'Beta', chapterText: 'Beta\n\nBeta begins.', notes: [], language: 'en' }]])
    expect(screen.getByRole('status')).toHaveTextContent('The chapter is shared with your assistant.')
    expect(opened).not.toHaveBeenCalled()
    expect(screen.getByTestId('v2-discuss-open')).toHaveFocus()
    await click('v2-discuss-open')
    const brief = `I'm reading "Dracula" by Bram Stoker in TextStack, at the chapter "Beta". Let's talk about it.\n\n(TextStack: book b1, share ${SHARE})`
    expect(opened.mock.calls).toEqual([[`https://claude.ai/new?q=${encodeURIComponent(brief)}`, '_blank', 'noopener,noreferrer']])
  })

  it('discuss_NoContents_TheSpineSectionSharedUnderItsSectionKeyWithNoChapterTitle', async () => {
    const { share, relocate, click, asked, answer } = await reader({ toc: [] })
    await relocate({ index: 2, chapterEnd: { tocIndex: null, section: 2 } })
    expect(screen.getByRole('button', { name: 'Discuss this chapter' })).toBeEnabled()
    await click('v2-discuss-share')
    expect(asked().map(([, tocIndex, section]) => [tocIndex, section])).toEqual([[null, 2]])
    await answer({ text: 'Second section.' })
    expect(share.mock.calls[0][1]).toMatchObject({ chapterKey: 'section-2', chapterTitle: null, chapterText: 'Second section.' })
  })

  it('discuss_ALongChapterCut_SaidOnScreenAndInTheMessage', async () => {
    const { opened, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 0, section: 0 } })
    await click('v2-discuss-share')
    await answer({ text: 'First part.', cut: true })
    expect(screen.getByRole('status')).toHaveTextContent('This chapter is long: only its first part was shared with your assistant.')
    await click('v2-discuss-open')
    expect(decodeURIComponent(String(opened.mock.calls[0][0]))).toContain("Let's talk about it. It is a long chapter: only its first part is shared.\n\n(TextStack: book b1, share ")
  })

  it('discuss_ShareFailsOffline_SaidWithRetry_NoChatOffered_RetryReplaysTheSameOperation', async () => {
    const { share, opened, relocate, click, answer } = await reader()
    share.mockRejectedValueOnce(Object.assign(new ApiError(0, 'down'), { isNetworkError: true }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(screen.getByRole('alert')).toHaveTextContent('You are offline, so the chapter was not shared. Try again when you are connected.')
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
    expect(opened).not.toHaveBeenCalled()

    expect(screen.getByTestId('v2-discuss-share')).toHaveTextContent('Retry')
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(share.mock.calls[1][1].operationId).toBe(share.mock.calls[0][1].operationId)
    expect(screen.getByTestId('v2-discuss-open')).toBeInTheDocument()
  })

  it('discuss_ServerRefuses_SaidByCause_ARefusedOperationIsNotReused', async () => {
    const { share, relocate, click, answer } = await reader()
    const v2 = (status: number, code: string) => Object.assign(new ApiError(status, code), { body: { code, message: code } })
    share.mockRejectedValueOnce(v2(404, 'book_not_found')).mockRejectedValueOnce(v2(409, 'operation_conflict')).mockRejectedValueOnce(new ApiError(401, 'no'))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    const alerts = []
    for (let i = 0; i < 3; i++) {
      await click('v2-discuss-share')
      await answer({ text: 'Beta begins.' })
      alerts.push(screen.getByRole('alert').textContent?.trim())
    }
    expect(alerts).toEqual([
      'This book is not on the server, so the chapter was not shared.',
      'The chapter was not shared. Try again.',
      'Your session ended, so the chapter was not shared. Sign in and try again.',
    ])
    const ops = share.mock.calls.map(([, b]) => b.operationId)
    expect(ops[1]).toBe(ops[0])
    expect(ops[2]).not.toBe(ops[1])
  })

  it('discuss_ThePageHasNoTextOrCannotReadIt_NothingShared_SaidWithRetry', async () => {
    const { share, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await answer({ error: 'empty' })
    expect(screen.getByRole('alert')).toHaveTextContent('This chapter has no text to share.')

    await click('v2-discuss-share')
    await answer({ error: 'unavailable' })
    expect(screen.getByRole('alert')).toHaveTextContent('This chapter could not be read, so nothing was shared. Try again.')
    expect(share).not.toHaveBeenCalled()
  })

  it('discuss_NoAnswerFromThePage_AfterTheDeadlineSaidAsUnreadable_ALateAnswerShares_Nothing', async () => {
    const { share, relocate, asked, fromPage } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    vi.useFakeTimers()
    await act(async () => { screen.getByTestId('v2-discuss-share').click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAPTER_TEXT_MS) })
    vi.useRealTimers()
    expect(screen.getByRole('alert')).toHaveTextContent('This chapter could not be read, so nothing was shared. Try again.')
    await fromPage({ type: 'chapter-text', request: asked()[0][0], text: 'late' })
    expect(share).not.toHaveBeenCalled()
  })

  it('chapterText_AnAnswerToNoRequestOfThisHost_OrOverTheCap_Dropped', async () => {
    const { share, relocate, click, fromPage, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await fromPage({ type: 'chapter-text', request: 'forged', text: 'x' })
    await click('v2-discuss-share')
    await fromPage({ type: 'chapter-text', request: 'forged', text: 'x' })
    await answer({ text: 'я'.repeat(200 * 1024 / 2 + 1) })
    expect(share).not.toHaveBeenCalled()
    expect(screen.getByTestId('v2-discuss-share')).toBeDisabled()
  })

  it('discuss_ScrolledAwayAndBack_TheShareIsStillThere_AnotherChapterStartsFresh', async () => {
    const { share, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await relocate({ chapterEnd: null })
    await answer({ text: 'Beta begins.' })
    expect(block()).toBeNull()
    await relocate({ chapterEnd: { tocIndex: 0, section: 0 } })
    expect(screen.getByTestId('v2-discuss-share')).toHaveTextContent('Discuss this chapter')
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    expect(screen.getByTestId('v2-discuss-open')).toBeInTheDocument()
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('discuss_AnotherBookOpenedWhileThePageReads_NothingSent_WhileTheShareIsInFlight_NothingOffered', async () => {
    const { share, relocate, click, answer, openBook } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await openBook()
    await answer({ text: 'Beta begins.' })
    expect(share).not.toHaveBeenCalled()

    let land: (s: V2Share) => void = () => {}
    share.mockImplementationOnce(() => new Promise<V2Share>((r) => { land = r }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(share).toHaveBeenCalledTimes(1)
    await openBook()
    await act(async () => { land({ id: SHARE, bookId: 'b1', chapterKey: 'toc-1', createdAt: '' }) })
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
    expect(screen.getByTestId('v2-discuss-share')).toHaveTextContent('Discuss this chapter')
  })

  it('discuss_TheAccountChangedWhileTheShareWasInFlight_NothingOffered', async () => {
    const { share, relocate, click, answer } = await reader()
    let land: (s: V2Share) => void = () => {}
    share.mockImplementationOnce(() => new Promise<V2Share>((r) => { land = r }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    v2Store.reset()
    await act(async () => { land({ id: SHARE, bookId: 'b1', chapterKey: 'toc-1', createdAt: '' }) })
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
  })

  it('discuss_NoAssistantConnected_NothingAskedOrShared_TheConnectDialogShown_ConnectedAfterIt_TheNextClickShares', async () => {
    listOAuthGrants.mockResolvedValue([])
    const { share, opened, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await click('v2-discuss-share')
    expect(screen.getByRole('dialog', { name: 'Connect Claude or ChatGPT in a minute' })).toBeInTheDocument()
    expect(asked()).toEqual([])
    expect(share).not.toHaveBeenCalled()

    listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
    await act(async () => {
      screen.getByRole('button', { name: 'Close' }).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(opened).not.toHaveBeenCalled()
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('discuss_ClickedTwice_OneRequestOneShare', async () => {
    const { share, relocate, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0 } })
    await act(async () => {
      const b = screen.getByTestId('v2-discuss-share')
      b.click()
      b.click()
    })
    expect(asked()).toHaveLength(1)
    await answer({ text: 'Beta begins.' })
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('titles_FromTheBook_AreTextOnScreenAndInTheMessage', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const { opened, relocate, click, answer } = await reader({ toc: [{ label: evil, href: 's1.xhtml', depth: 0 }], title: evil })
    await relocate({ chapterEnd: { tocIndex: 0, section: 0 } })
    expect(screen.getByTestId('v2-discuss-share').getAttribute('aria-label')).toBe(`Discuss the chapter ${evil} with your assistant`)
    expect(screen.getByTestId('v2-finish-block').querySelector('img')).toBeNull()
    await click('v2-discuss-share')
    await answer({ text: 'x' })
    await click('v2-discuss-open')
    expect(decodeURIComponent(String(opened.mock.calls[0][0]))).toContain(`I'm reading "${evil}" by Bram Stoker in TextStack, at the chapter "${evil}".`)
  })
})
