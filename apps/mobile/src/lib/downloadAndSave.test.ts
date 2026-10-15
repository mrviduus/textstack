import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { downloadAndSave } from './downloadAndSave'

/** Download on the book screen (QA-007 LIB-1, LIB-1a). The screen is not mountable here: its wiring is pinned in the source. */
const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8')

describe('downloadAndSave', () => {
  // A test that fails on fake timers must not leave them to the next one.
  afterEach(() => { vi.useRealTimers() })

  it('QA-007 LIB-1: Cancel stops the download only — the book stays in the Library (a download is intent)', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/onCancel=\{\(\) => cancelDownload\(book\.id\)\}/)
    expect(src).toMatch(/onRemove=\{\(\) => removeDownload\(book\.id\)\.then\(\(\) => setCached\(false\)\)\}/)
  })

  it('QA-007 LIB-1 wiring: Download/Retry/Restart share one handler (its save: useBookLibrary.test.ts)', () => {
    const src = read('app/book/[slug].tsx')
    expect(src).toMatch(/onStart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
    expect(src).toMatch(/onRetry=\{onDownload\(\(\) => retryFailed\(book\.id\)\)\}/)
    expect(src).toMatch(/onRestart=\{onDownload\(\(\) => startDownload\(book, language\)\)\}/)
  })

  it('QA-007 LIB-1a: Download with no session mints a guest first, then saves; a failed or never-answering mint still downloads, without the save', async () => {
    // No session → mint → save as a fresh (empty-Library) guest.
    let run = vi.fn(); let save = vi.fn(); let ensureSession = vi.fn(async () => ({ status: 'minted' as const }))
    await downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession, save })
    expect(run).toHaveBeenCalledTimes(1); expect(ensureSession).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1)
    // Mint fails → download only.
    run = vi.fn(); save = vi.fn()
    await downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession: async () => ({ status: 'failed' as const, error: new Error('offline') }), save })
    expect(run).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
    // Mint never answers → download only (nothing waits on it).
    vi.useFakeTimers()
    run = vi.fn(); save = vi.fn()
    void downloadAndSave({ run, getAccessToken: async () => null, hasSession: false, ensureSession: () => new Promise(() => {}), save })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(save).not.toHaveBeenCalled()
    vi.useRealTimers()
    // A session already there → no mint.
    save = vi.fn(); ensureSession = vi.fn()
    await downloadAndSave({ run: vi.fn(), getAccessToken: async () => null, hasSession: true, ensureSession, save })
    expect(ensureSession).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledTimes(1)
    // Wiring: the screen's Download handler goes through it with the auth context's ensureSession.
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession, getAccessToken,/)
  })

  it('QA-007 LIB-1a: a mint that answers after 3 s still saves, in the background; a discarded mint saves under the winning session', async () => {
    vi.useFakeTimers()
    let save = vi.fn()
    const p = downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => null, save,
      ensureSession: () => new Promise(r => setTimeout(() => r({ status: 'minted' as const }), 4000)) })
    await vi.advanceTimersByTimeAsync(4000); await p
    expect(save).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    // Another session won the race → save under it.
    save = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => 'tok', save,
      ensureSession: async () => ({ status: 'discarded' as const, reason: 'account-arrived' as const }) })
    expect(save).toHaveBeenCalledTimes(1)
    // Discarded and nobody holds a session (signed out meanwhile) → no save.
    save = vi.fn()
    await downloadAndSave({ run: vi.fn(), hasSession: false, getAccessToken: async () => null, save,
      ensureSession: async () => ({ status: 'discarded' as const, reason: 'epoch-moved' as const }) })
    expect(save).not.toHaveBeenCalled()
    expect(read('app/book/[slug].tsx')).toMatch(/downloadAndSave\(\{ run, hasSession: isAuthenticated, ensureSession, getAccessToken,/)
  })
})
