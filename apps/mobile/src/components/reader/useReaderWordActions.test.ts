// @vitest-environment jsdom
/**
 * SEL-1 through the real hooks: an action closes the selection it STARTED with, never one the
 * reader opened while it waited on the network.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderWordActions } from './useReaderWordActions'
import { useReaderHighlights } from '../../hooks/useReaderHighlights'
import { clearSelectionJs } from '../../lib/readerSelectionJs'

const api = vi.hoisted(() => ({ saveWord: vi.fn(), createHighlight: vi.fn() }))
vi.mock('@textstack/shared', async orig => {
  const real = await orig<typeof import('@textstack/shared')>()
  return {
    ...real,
    vocabularyApi: { ...real.vocabularyApi, saveWord: api.saveWord },
    highlightsApi: { ...real.highlightsApi, createHighlight: api.createHighlight, getHighlights: async () => [] },
  }
})
vi.mock('../../hooks/useReaderVocabMap', () => ({
  useReaderVocabMap: () => ({ vocabMapRef: { current: {} }, flushToCache: () => {}, bumpVocab: () => {} }),
}))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function mount() {
  const injected: string[] = []
  const showToast = vi.fn()
  const h = renderHook(useReaderWordActions, {
    source: { kind: 'edition', id: 'e1', idRef: { current: 'e1' } } as never,
    injectJs: (js: string) => { injected.push(js) },
    bookTitleRef: { current: 'Book' },
    original: false,
    chapter: { id: 'c1' },
    user: { id: 'u1' } as never,
    isAuthenticated: true,
    language: 'en',
    textLanguage: 'en',
    nativeLanguage: 'uk',
    settings: { lastHighlightColor: 'yellow' } as never,
    updateSettings: vi.fn(),
    haptics: { play: vi.fn() } as never,
    showToast,
    router: { push: vi.fn() } as never,
    sessionWordCountRef: { current: 0 },
    setSessionWordCount: vi.fn(),
    footerHeight: 0,
  })
  const open = (text: string, token: number) =>
    act(() => { h.result.current.openSelection({ text, sentence: `${text}.`, mode: 'tap', token }) })
  return { h, injected, showToast, open }
}

describe('SEL-1 — a late action closes only its own selection', () => {
  it('highlight A resolves after B opened → B stays open, B is not cleared', async () => {
    const { h, injected, open } = mount()
    const slow = deferred<{ id: string }>()
    api.createHighlight.mockReturnValueOnce(slow.promise)
    open('alpha', 11)
    let done!: Promise<void>
    act(() => { done = h.result.current.handleHighlight('yellow') })
    open('beta', 12)
    await act(async () => { slow.resolve({ id: 'h1' }); await done })
    expect(h.result.current.selection?.text).toBe('beta')
    expect(injected).not.toContain(clearSelectionJs(12))
    // The paint drops A's word mark, by A's token.
    expect(injected.some(js => js.startsWith(clearSelectionJs(11, true)))).toBe(true)
  })

  it('a save that resolves (already saved) after B opened → B stays open', async () => {
    const { h, injected, open } = mount()
    const slow = deferred<{ outcome: string }>()
    api.saveWord.mockReturnValueOnce(slow.promise)
    open('alpha', 21)
    let done!: Promise<unknown>
    act(() => { done = h.result.current.handleSaveWord() as Promise<unknown> })
    open('beta', 22)
    await act(async () => { slow.resolve({ outcome: 'already_saved' }); await done })
    expect(h.result.current.selection?.text).toBe('beta')
    expect(injected).not.toContain(clearSelectionJs(22))
  })

  it('highlight with its own selection still open closes it and clears the WebView by its token', async () => {
    const { h, injected, open } = mount()
    api.createHighlight.mockResolvedValueOnce({ id: 'h2' })
    open('alpha', 31)
    await act(async () => { await h.result.current.handleHighlight('yellow') })
    expect(h.result.current.selection).toBeNull()
    expect(injected).toContain(clearSelectionJs(31))
  })

  it('closing a selection with no token closes the toolbar only — no WebView clear', () => {
    const { h, injected } = mount()
    act(() => { h.result.current.openSelection({ text: 'alpha', sentence: 'alpha.', mode: 'tap' }) })
    act(() => { h.result.current.closeSelection() })
    expect(h.result.current.selection).toBeNull()
    expect(injected.some(js => js.includes('__tsClearSelection'))).toBe(false)
  })
})

describe('SEL-1 — highlight create with no book id', () => {
  it('shows the failed-save toast and reports failure (selection stays)', async () => {
    const showToast = vi.fn()
    const h = renderHook(useReaderHighlights, {
      editionId: null, editionIdRef: { current: null },
      user: { id: 'u1' }, isAuthenticated: true, chapterId: 'c1',
      injectJs: () => {}, showToast,
    })
    let ok: boolean | undefined
    await act(async () => { ok = await h.result.current.create({ color: 'yellow', selection: { text: 'alpha' }, chapter: { id: 'c1' } }) })
    expect(ok).toBe(false)
    expect(showToast).toHaveBeenCalledWith({ message: 'Could not add highlight. Try again.', variant: 'error' })
  })
})
