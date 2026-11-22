import { ApiError, CHAPTER_TEXT_MS, type Share, type ShareWrite } from '@textstack/shared'
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
/** The signed-in account the host sees (#1316 review: a share in flight belongs to the account that asked). */
let account: { id: string } | null = { id: 'u1' }
vi.mock('../../context/AuthContext', async (actual) => {
  const real = await actual<typeof import('../../context/AuthContext')>()
  return { ...real, useAuth: () => ({ ...real.useAuth(), user: account, isAuthenticated: !!account }) }
})

const SHA = 'a'.repeat(64)
const T: V2SyncTarget = { bookId: 'b1', fileId: 'f1', format: 'epub', sha256: SHA, size: 8, name: 'b1.epub' }
const SHARE = '5ba7ed00-0000-4000-8000-000000000001'
const TOC = [{ label: 'Alpha', href: 's1.xhtml#a', depth: 0 }, { label: 'Beta', href: 's1.xhtml#b', depth: 1 }, { label: 'Gamma', href: 's3.xhtml', depth: 0 }]

beforeEach(() => {
  account = { id: 'u1' }
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
  const share = vi.spyOn(v2DiscussApi, 'shareChapter').mockImplementation(async (bookId: string, body: ShareWrite): Promise<Share> =>
    ({ id: SHARE, bookId, chapterKey: body.chapterKey, createdAt: '2026-11-15T10:00:00Z' }))
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
  let lastBook: V2HostBook | null = null
  const host = (book: V2HostBook | null) => { lastBook = book; return <MemoryRouter><V2ReaderHost book={book} dev={o.dev} /></MemoryRouter> }
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
  /** A new book handed to the host, the page not yet answering for it. */
  const startOpen = () => act(async () => { view.rerender(host({ bytes: new ArrayBuffer(8), name: T.name, sync: o.dev ? undefined : T })) })
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
  /** Another account (or none): the host re-renders with it. */
  const signIn = (who: { id: string } | null) => act(async () => {
    account = who
    view.rerender(host(lastBook))
  })
  return { share, opened, relocate, click, asked, answer, openBook, startOpen, fromPage, signIn }
}
const block = () => screen.queryByTestId('v2-discuss')

describe('V2ReaderHost discuss chapter (#1316)', () => {
  it('relocate_ChapterEndThenAway_BlockShownForThatEntryThenHidden_NeverGuessedFromTheEntryOrTheFraction', async () => {
    const { relocate } = await reader()
    await relocate({ tocIndex: 1, fraction: 1, atEnd: false })
    expect(block()).toBeNull()
    await relocate({ tocIndex: 2, chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(screen.getByRole('button', { name: 'Discuss the chapter Beta with your assistant' })).toHaveTextContent('Discuss this chapter')
    await relocate({ tocIndex: 2, chapterEnd: null })
    expect(block()).toBeNull()
  })

  it('chapterEnd_Malformed_NoBlock_FrontMatterByItsTitle_NoBlock', async () => {
    const { relocate } = await reader()
    for (const chapterEnd of [{ tocIndex: '1', section: 0, title: 'Beta' }, { tocIndex: 1, title: 'Beta' }, 'toc-1', { tocIndex: 1, section: 0, title: 'Copyright' }, { tocIndex: 0, section: 0, title: 'Table of Contents' }]) {
      await relocate({ chapterEnd })
      expect(block()).toBeNull()
    }
  })

  // The page's word is the rule (review R2): the host never looks the entry up in its own contents.
  it('chapterEnd_AnEntryTheHostsOwnContentsDoNotHold_OfferedByThePagesTitle_ASectionOfABookTheHostListsContentsFor_Offered', async () => {
    const { share, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 9, section: 4, title: 'Nine' } })
    expect(screen.getByRole('button', { name: 'Discuss the chapter Nine with your assistant' })).toBeEnabled()
    await click('v2-discuss-share')
    expect(asked().map(([, tocIndex, section]) => [tocIndex, section])).toEqual([[9, 4]])
    await answer({ text: 'Nine.' })
    expect(share.mock.calls[0][1]).toMatchObject({ chapterKey: 'toc-9', chapterTitle: 'Nine' })
    await relocate({ chapterEnd: { tocIndex: null, section: 0, title: null } })
    expect(screen.getByRole('button', { name: 'Discuss this chapter' })).toBeEnabled()
    await relocate({ chapterEnd: { tocIndex: 2, section: 0, title: '  ' } })
    expect(screen.getByRole('button', { name: 'Discuss this chapter' })).toBeEnabled()
  })

  // The page says a chapter end it learned late as its own message, for the place last reported.
  it('chapterEnd_SaidLaterByThePage_BlockShown_TheNextRelocateIsThePagesWordAgain', async () => {
    const { relocate, fromPage } = await reader()
    await relocate({ chapterEnd: null })
    expect(block()).toBeNull()
    await fromPage({ type: 'chapter-end', chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(screen.getByRole('button', { name: 'Discuss the chapter Beta with your assistant' })).toBeEnabled()
    await relocate({ chapterEnd: null })
    expect(block()).toBeNull()
    await fromPage({ type: 'chapter-end', chapterEnd: { tocIndex: 1, title: 'Beta' } })
    expect(block()).toBeNull()
  })

  // Review R3: from the start of an open (before the page answers for it) nothing of the previous book is offered.
  it('openStarted_ThePreviousBooksChapterEndStillArriving_NoBlock_NothingSharedUnderThePreviousBook', async () => {
    const { share, relocate, startOpen, asked } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(block()).not.toBeNull()
    await startOpen()
    expect(block()).toBeNull()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(block()).toBeNull()
    expect(asked()).toEqual([])
    expect(share).not.toHaveBeenCalled()
  })

  it('devRoute_NoServerBook_NoBlock', async () => {
    const { relocate } = await reader({ dev: true })
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(block()).toBeNull()
  })

  it('discuss_Clicked_ThatEntrysTextSharedUnderBookFileAndKey_ThenTheChatOpensWithTheBookAndShareIds', async () => {
    const { share, opened, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ index: 2, chapterEnd: { tocIndex: null, section: 2, title: null } })
    expect(screen.getByRole('button', { name: 'Discuss this chapter' })).toBeEnabled()
    await click('v2-discuss-share')
    expect(asked().map(([, tocIndex, section]) => [tocIndex, section])).toEqual([[null, 2]])
    await answer({ text: 'Second section.' })
    expect(share.mock.calls[0][1]).toMatchObject({ chapterKey: 'section-2', chapterTitle: null, chapterText: 'Second section.' })
  })

  it('discuss_ALongChapterCut_SaidOnScreenAndInTheMessage', async () => {
    const { opened, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 0, section: 0, title: 'Alpha' } })
    await click('v2-discuss-share')
    await answer({ text: 'First part.', cut: true })
    expect(screen.getByRole('status')).toHaveTextContent('This chapter is long: only its first part was shared with your assistant.')
    await click('v2-discuss-open')
    expect(decodeURIComponent(String(opened.mock.calls[0][0]))).toContain("Let's talk about it. It is a long chapter: only its first part is shared.\n\n(TextStack: book b1, share ")
  })

  it('discuss_ShareFailsOffline_SaidWithRetry_NoChatOffered_RetryReplaysTheSameOperation', async () => {
    const { share, opened, relocate, click, answer } = await reader()
    share.mockRejectedValueOnce(Object.assign(new ApiError(0, 'down'), { isNetworkError: true }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await fromPage({ type: 'chapter-text', request: 'forged', text: 'x' })
    await click('v2-discuss-share')
    await fromPage({ type: 'chapter-text', request: 'forged', text: 'x' })
    await answer({ text: 'я'.repeat(200 * 1024 / 2 + 1) })
    expect(share).not.toHaveBeenCalled()
    expect(screen.getByTestId('v2-discuss-share')).toBeDisabled()
  })

  it('discuss_ScrolledAwayAndBack_TheShareIsStillThere_AnotherChapterStartsFresh', async () => {
    const { share, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await relocate({ chapterEnd: null })
    await answer({ text: 'Beta begins.' })
    expect(block()).toBeNull()
    await relocate({ chapterEnd: { tocIndex: 0, section: 0, title: 'Alpha' } })
    expect(screen.getByTestId('v2-discuss-share')).toHaveTextContent('Discuss this chapter')
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(screen.getByTestId('v2-discuss-open')).toBeInTheDocument()
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('discuss_AnotherBookOpenedWhileThePageReads_NothingSent_WhileTheShareIsInFlight_NothingOffered', async () => {
    const { share, relocate, click, answer, openBook } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await openBook()
    // The new book has said nothing of a chapter end yet: the previous book's block is gone.
    expect(block()).toBeNull()
    await answer({ text: 'Beta begins.' })
    expect(share).not.toHaveBeenCalled()

    let land: (s: Share) => void = () => {}
    share.mockImplementationOnce(() => new Promise<Share>((r) => { land = r }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(share).toHaveBeenCalledTimes(1)
    await openBook()
    await act(async () => { land({ id: SHARE, bookId: 'b1', chapterKey: 'toc-1', createdAt: '' }) })
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
    expect(screen.getByTestId('v2-discuss-share')).toHaveTextContent('Discuss this chapter')
  })

  it('discuss_TheAccountChangedWhileTheShareWasInFlight_NothingOffered', async () => {
    const { share, relocate, click, answer } = await reader()
    let land: (s: Share) => void = () => {}
    share.mockImplementationOnce(() => new Promise<Share>((r) => { land = r }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    v2Store.reset()
    await act(async () => { land({ id: SHARE, bookId: 'b1', chapterKey: 'toc-1', createdAt: '' }) })
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
  })

  it('discuss_NoAssistantConnected_NothingAskedOrShared_TheConnectDialogShown_ConnectedAfterIt_TheNextClickShares', async () => {
    listOAuthGrants.mockResolvedValue([])
    const { share, opened, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    // No chat was ever opened without a message (review 4): the only open is the reader's own, with the brief.
    await click('v2-discuss-open')
    expect(opened.mock.calls.map(([url]) => String(url))).toEqual([expect.stringContaining(encodeURIComponent('(TextStack: book b1, share '))])
  })

  // Review 6: only the share landing while the block is on screen takes the focus.
  it('ready_TheBlockShownAgainAfterPagingAway_FocusNotTaken', async () => {
    const { relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(screen.getByTestId('v2-discuss-open')).toHaveFocus()
    await relocate({ chapterEnd: null })
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    expect(screen.getByTestId('v2-discuss-open')).not.toHaveFocus()
  })

  // Review 7: after the connect dialog of the second step the grants are asked again at once, so the next click
  // opens the chat inside the click.
  // Review round 2, item 3: one decision from one source. A failed grants request is said as such, never read as
  // "none connected"; after the share, the chat opens from the grants that run found, never asked again.
  it('grantsRequestFails_SaidOffline_NoConnectDialog_NothingShared_TheRetryAsksAgain', async () => {
    listOAuthGrants.mockReset().mockRejectedValueOnce(Object.assign(new ApiError(0, 'down'), { isNetworkError: true })).mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
    const { share, relocate, click, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    expect(screen.getByRole('alert')).toHaveTextContent('You are offline, so the chapter was not shared.')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(asked()).toEqual([])
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(share).toHaveBeenCalledTimes(1)
    expect(listOAuthGrants).toHaveBeenCalledTimes(2)
  })

  it('ready_TheChatOpensFromTheRunsGrants_InsideTheClick_NothingAskedAgain_EvenWhenTheServerNowFails', async () => {
    const { opened, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    listOAuthGrants.mockReset().mockRejectedValue(new Error('down'))
    screen.getByTestId('v2-discuss-open').click()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(listOAuthGrants).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ready_TwoAssistantsNothingRemembered_ThePickOpensTheChosenOne_Remembered', async () => {
    listOAuthGrants.mockReset().mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
    localStorage.removeItem('chapterReview.assistant')
    const { opened, relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    await click('v2-discuss-open')
    expect(opened).not.toHaveBeenCalled()
    await act(async () => { screen.getByRole('menuitem', { name: 'ChatGPT' }).click() })
    expect(String(opened.mock.calls[0][0])).toMatch(/^https:\/\/chatgpt\.com\/\?q=/)
    expect(localStorage.getItem('chapterReview.assistant')).toBe('chatgpt')
  })

  // Item 6: the share landing never takes the focus from where the reader went meanwhile.
  it('ready_TheReaderFocusedSomethingElseWhileSharing_FocusStaysThere', async () => {
    const { relocate, click, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    const field = document.createElement('textarea')
    document.body.append(field)
    field.focus()
    await answer({ text: 'Beta begins.' })
    expect(screen.getByTestId('v2-discuss-open')).toBeInTheDocument()
    expect(field).toHaveFocus()
    field.remove()
  })

  // Item 4: the session ends mid-share: after the next sign-in the block is usable without reopening the book.
  it('accountChangedMidShare_TheBlockIsIdleAtOnce_ANewDiscussRunsUnderTheNewAccount_TheOldAnswerShowsNothing', async () => {
    const { share, relocate, click, asked, answer, signIn } = await reader()
    let land: (s: Share) => void = () => {}
    share.mockImplementationOnce(() => new Promise<Share>((r) => { land = r }))
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
    await click('v2-discuss-share')
    await answer({ text: 'Beta begins.' })
    expect(screen.getByTestId('v2-discuss-share')).toBeDisabled()
    await signIn(null)
    await signIn({ id: 'u2' })
    expect(screen.getByTestId('v2-discuss-share')).toBeEnabled()
    await click('v2-discuss-share')
    expect(asked()).toHaveLength(2)
    await act(async () => { land({ id: SHARE, bookId: 'b1', chapterKey: 'toc-1', createdAt: '' }) })
    expect(screen.queryByTestId('v2-discuss-open')).toBeNull()
    await answer({ text: 'Beta begins.' })
    expect(screen.getByTestId('v2-discuss-open')).toBeInTheDocument()
    expect(share.mock.calls[1][1].operationId).not.toBe(share.mock.calls[0][1].operationId)
  })

  it('discuss_ClickedTwice_OneRequestOneShare', async () => {
    const { share, relocate, asked, answer } = await reader()
    await relocate({ chapterEnd: { tocIndex: 1, section: 0, title: 'Beta' } })
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
    await relocate({ chapterEnd: { tocIndex: 0, section: 0, title: evil } })
    expect(screen.getByTestId('v2-discuss-share').getAttribute('aria-label')).toBe(`Discuss the chapter ${evil} with your assistant`)
    expect(screen.getByTestId('v2-finish-block').querySelector('img')).toBeNull()
    await click('v2-discuss-share')
    await answer({ text: 'x' })
    await click('v2-discuss-open')
    expect(decodeURIComponent(String(opened.mock.calls[0][0]))).toContain(`I'm reading "${evil}" by Bram Stoker in TextStack, at the chapter "${evil}".`)
  })
})
