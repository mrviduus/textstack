import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { initApi } from '@textstack/shared'
import NetInfo from '@react-native-community/netinfo'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { resetSyncForTests, reloadLastSyncAnswerForTests, forgetSyncAnswer, syncOn, startSyncProbe, reprobeSyncAfterReconnect, uploadBook, saveProgress, sha256Of, FileUploadError, MAX_DEVICE_PART_BYTES, pullBooks, deviceUploadIo, syncStore, getUserBooks, bookChapters, readProgress, uploadPicked, UPLOAD_PICKER_TYPES, PICKER_TYPES_BY_FORMAT, type UploadIo, type UploadStaging } from './sync'
import en from '../../../../packages/shared/src/i18n/en.json'
import { vocabularyApi } from './vocabularyApi'
import { getUserBookLocalProgress, setUserBookSyncState, getUserBookSyncState } from './progressStorage'
import { fakeApi as fakeV2, conflict, state, feed, book, file, resetMidCall as midCall, type Answer, type Call } from '../../../../packages/shared/src/api/__tests__/fakeSyncApi'

const V2 = 'http://api/me/v2'
const fakeApi = (routes: Record<string, Answer[]>) => fakeV2(routes, V2)
const resetMidCall = <T>(routes: Record<string, Answer>, op: () => Promise<T>, hold?: string) => midCall(() => syncStore.reset(), routes, op, hold)

const bytes = Uint8Array.from({ length: 25 }, (_, i) => i)
const sha = createHash('sha256').update(bytes).digest('hex')

function io(sent: Uint8Array[] = []): UploadIo {
  return {
    open: () => ({ size: bytes.length, read: (at, n) => bytes.slice(at, at + n), close: () => {} }),
    sendPart: async (bookId, fileId, index, part) => {
      sent.push(part)
      return { index, size: part.length }
    },
    yieldNow: async () => {},
  }
}

describe('mobile v2', () => {
  beforeEach(() => {
    resetSyncForTests()
    initApi({ baseUrl: 'http://api', getAccessToken: async () => 't', onUnauthorized: async () => null })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is off for this start when the status route is not mapped, even after a reconnect', async () => {
    const calls = fakeApi({ 'GET /status': [{ status: 404 }] })
    expect((await startSyncProbe()).enabled).toBe(false)
    expect((await reprobeSyncAfterReconnect()).enabled).toBe(false)
    expect(calls).toHaveLength(1)
  })

  // M5 (#1031): an offline cold start keeps the last answer (stored); sign-out forgets it.
  it.each([[200, true], [404, false]])('probe_LastStartAnswered%i_AnOfflineStartKeepsIt_SignOutForgetsIt (%s)', async (status, on) => {
    fakeApi({ 'GET /status': [status === 200 ? { status, body: { maxPartBytes: 1024 } } : { status }] })
    expect((await startSyncProbe()).enabled).toBe(on)
    resetSyncForTests() // the next app start
    await reloadLastSyncAnswerForTests()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startSyncProbe()).enabled).toBe(on)
    forgetSyncAnswer()
    await vi.waitFor(async () => expect(await AsyncStorage.getItem('v2.lastStatus')).toBeNull())
    resetSyncForTests()
    await reloadLastSyncAnswerForTests()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startSyncProbe()).enabled).toBe(false)
  })

  it('asks again on a reconnect when the probe never reached the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startSyncProbe()).enabled).toBe(false)
    expect((await startSyncProbe()).enabled).toBe(false) // no retry per call while offline
    fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    expect(await reprobeSyncAfterReconnect()).toEqual({ enabled: true, maxPartBytes: 1024 })
  })

  // #1141: a screen's reconnect effect runs before AuthContext's re-probe; the NetInfo event already marked the offline answer stale.
  it('syncOn after a reconnect asks the probe again instead of answering the offline one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    expect((await startSyncProbe()).enabled).toBe(false)
    const calls = fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    ;(NetInfo as unknown as { __emit(s: object): void }).__emit({ isConnected: false, isInternetReachable: false })
    expect(await syncOn()).toBe(false) // still offline: no new probe
    expect(calls).toHaveLength(0)
    ;(NetInfo as unknown as { __emit(s: object): void }).__emit({ isConnected: true, isInternetReachable: true })
    expect(await syncOn()).toBe(true)
    expect(calls.map((c) => c.path)).toEqual(['/status'])
  })

  // #1140: the feed pull is shared — one request per pull, not one per caller.
  it('concurrent library pulls share one request', async () => {
    const calls = fakeApi({ 'GET /library/changes': [{ status: 200, body: { items: [], cursor: null, hasMore: false } }] })
    await Promise.all([pullBooks(), pullBooks(), pullBooks()])
    expect(calls).toHaveLength(1)
  })

  // #1140: a failed pull must not be handed to every later caller.
  it('a failed library pull is not shared with the next pull', async () => {
    const calls = fakeApi({ 'GET /library/changes': [{ status: 500 }, { status: 200, body: { items: [], cursor: null, hasMore: false } }] })
    await expect(pullBooks()).rejects.toBeDefined()
    expect(await pullBooks()).toEqual([])
    expect(calls.filter((c) => c.path === '/library/changes')).toHaveLength(2)
  })

  // #1140: sign-out mid-pull — the next account's pull is its own, not the previous account's.
  it('syncStore.reset during a pull starts a fresh pull next', async () => {
    const calls = fakeApi({ 'GET /library/changes': [{ status: 200, body: { items: [], cursor: null, hasMore: false } }] })
    const first = pullBooks()
    syncStore.reset()
    await Promise.all([first, pullBooks()])
    expect(calls.filter((c) => c.path === '/library/changes')).toHaveLength(2)
  })

  // #1141: one NetInfo subscription for the app's life, however many probes fail.
  it('repeated unreached probes subscribe to NetInfo once', async () => {
    const net = NetInfo as unknown as { __count(): number }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    const before = net.__count()
    await startSyncProbe()
    await reprobeSyncAfterReconnect()
    await reprobeSyncAfterReconnect()
    expect(net.__count()).toBe(before + 1)
  })

  // #1140 review: a pull that outlives a sign-out never fills the next account's store.
  it('a pull that started before syncStore.reset does not write the store', async () => {
    let answer!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ items: [{ id: 'old-acct-book', currentFile: null }], cursor: null, hasMore: false }) })
    })))
    const first = pullBooks()
    await Promise.resolve()
    syncStore.reset()
    answer()
    await first
    expect(syncStore.books.size).toBe(0)
  })

  // #1140 second review: the shelf of a pull that outlived a sign-out is neither mapped, fetched nor shown.
  // #1191: and it is a retryable 503, never `[]` — the orphan sweep reads an empty list as "delete every download".
  it('getUserBooks after syncStore.reset mid-pull throws a retryable 503 and fetches no chapters', async () => {
    const answers: Array<() => void> = []
    const fetchSpy = vi.fn((url: string) => new Promise((resolve) => {
      const body = url.includes('/library/') ? { items: [{ id: 'old-acct-book', currentFile: { id: 'f', hasContent: true } }], cursor: null, hasMore: false }
        : { items: [], cursor: null, hasMore: false }
      answers.push(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) }))
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const shelf = getUserBooks()
    await new Promise((r) => setTimeout(r, 0))
    syncStore.reset()
    for (const a of answers) a()
    await expect(shelf).rejects.toMatchObject({ status: 503 })
    expect(fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/chapters'))).toHaveLength(0)
  })

  // #1118: the shelf is the two feeds; each book's status and chapter count are its file's, no /chapters call.
  it('getUserBooks_FeedCarriesSummary_MapsFourShapesWithTwoPullsOnly', async () => {
    const calls = fakeApi({
      'GET /library/changes': feed(
        book('ready', 'f1', { currentFile: file('f1', { chapterCount: 3 }) }),
        book('no-toc', 'f2'),
        book('no-bytes', 'f3', { currentFile: file('f3', { hasContent: false }) }),
        book('mobi', 'f5', { currentFile: file('f5', { format: 'mobi' }) }),
      ),
      'GET /reading/changes': feed(),
    })
    const shelf = await getUserBooks()
    expect(shelf.map((b) => [b.id, b.status, b.chapterCount, b.totalWordCount])).toEqual([
      ['ready', 'Ready', 3, null], ['no-toc', 'Ready', 0, null], ['no-bytes', 'Failed', 0, null], ['mobi', 'Ready', 0, null],
    ])
    expect(calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/library/changes', '/reading/changes'])
  })

  it('getUserBooks_EpubCfiState_ResumesOnlyFromAnAlreadyReadToc', async () => {
    const cfi = { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' }
    const calls = fakeApi({
      'GET /library/changes': [...feed(book('b1', 'f1')), ...feed(book('b1', 'f1'))],
      'GET /reading/changes': [...feed(state('b1', 1, { currentLocator: cfi })), ...feed(state('b1', 1, { currentLocator: cfi }))],
    })
    expect((await getUserBooks())[0].progressChapterSlug).toBeNull()
    syncStore.chapters.set('f1', { items: [{ chapterKey: 'one', chapterNumber: 1, title: 'One' }, { chapterKey: 'two', chapterNumber: 2, title: 'Two' }] })
    expect((await getUserBooks())[0].progressChapterSlug).toBe('two')
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })

  // #1151: per-book writes made after an await drop when the store was reset meanwhile.
  it('a chapters fetch answered after syncStore.reset caches nothing', async () => {
    const one = { chapterKey: 'one', chapterNumber: 0, title: 'One' }
    const toc = await resetMidCall({ 'GET /books/b/files/f-ch/chapters': { status: 200, body: { items: [one] } } },
      () => bookChapters(book('b', 'f-ch') as never))
    expect(toc).toEqual({ items: [] })
    expect(syncStore.chapters.size).toBe(0)
  })

  it('a reading-state read answered after syncStore.reset remembers nothing', async () => {
    await resetMidCall({ 'GET /books/b-read/reading-state': { status: 200, body: state('b-read', 4) } }, () => readProgress('b-read'))
    expect(syncStore.states.size).toBe(0)
    expect(await getUserBookSyncState('b-read')).toBeNull()
  })

  it('a reading-state write answered after syncStore.reset remembers nothing and is not marked synced', async () => {
    await setUserBookSyncState('b-save', { revision: 1, fileId: 'f1' })
    const outcome = await resetMidCall({ 'PUT /books/b-save/reading-state': { status: 200, body: state('b-save', 2) } },
      () => saveProgress('b-save', { chapterSlug: 'k1' }))
    expect(outcome).toBe('dropped')
    expect(syncStore.states.size).toBe(0)
    expect(await getUserBookSyncState('b-save')).toEqual({ revision: 1, fileId: 'f1' })
  })

  it('a write lost (409) after syncStore.reset adopts nothing', async () => {
    await setUserBookSyncState('b-lost', { revision: 1, fileId: 'f1' })
    const outcome = await resetMidCall({ 'PUT /books/b-lost/reading-state': conflict('stale_revision', { current: state('b-lost', 9) }) },
      () => saveProgress('b-lost', { chapterSlug: 'k1' }))
    expect(outcome).toBe('dropped')
    expect(await getUserBookSyncState('b-lost')).toEqual({ revision: 1, fileId: 'f1' })
    expect(await getUserBookLocalProgress('b-lost')).toBeNull()
  })

  it('an adopt whose chapters load outlives syncStore.reset writes no local record', async () => {
    await setUserBookSyncState('b-adopt', { revision: 1, fileId: 'f1' })
    // An epub-cfi place resumes by fraction: adopt loads the chapters, and the reset lands there.
    const current = state('b-adopt', 7, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/2)' } })
    const outcome = await resetMidCall({
      'PUT /books/b-adopt/reading-state': conflict('stale_revision', { current }),
      'GET /library/changes': feed(book('b-adopt', 'f1'))[0],
      'GET /books/b-adopt/files/f1/chapters': { status: 200, body: { items: [] } },
    }, () => saveProgress('b-adopt', { chapterSlug: 'k1' }), '/books/b-adopt/files/f1/chapters')
    // Web's answer since the shared fold (#1121): no place is adopted for the next account.
    expect(outcome).toBe('dropped')
    expect(await getUserBookLocalProgress('b-adopt')).toBeNull()
  })

  it('a vocabulary read answered after syncStore.reset returns nothing and remembers no card revision', async () => {
    const queue = await resetMidCall({ 'GET /status': { status: 200, body: { maxPartBytes: 1024 } }, 'GET /vocabulary/due': { status: 200, body: [{ id: 'w-old', revision: 3, examples: [] }] } },
      () => vocabularyApi.getReviewQueue(10, false), '/vocabulary/due')
    expect(queue).toEqual({ cards: [], totalDue: 0, weeklyProgress: null }) // the previous account's cards never reach the screen
    expect(syncStore.cards.size).toBe(0)
  })

  // #1143 second review: Cancel while the last part is in flight never completes the upload.
  it('a cancel during the last part removes the book instead of completing it', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    let cancelled = false
    const device: UploadIo = {
      ...deviceUploadIo(() => cancelled),
      open: () => ({ size: bytes.length, read: (at, n) => bytes.slice(at, at + n), close: () => {} }),
      sendPart: async () => { cancelled = true }, // the only part: Cancel lands while it is in flight
    }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 25, device)).rejects.toMatchObject({ aborted: true })
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/content'))).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: put.path })
  })

  // Test hygiene: the reset drops the NetInfo subscription, so suites never stack listeners.
  it('resetSyncForTests unsubscribes NetInfo', async () => {
    const net = NetInfo as unknown as { __count(): number }
    const before = net.__count()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    await startSyncProbe()
    expect(net.__count()).toBe(before + 1)
    resetSyncForTests()
    expect(net.__count()).toBe(before)
  })

  // #1141 review: the network came back while a probe was in flight, and that probe then failed offline.
  it('a probe that fails after an online event mid-flight is asked again', async () => {
    const net = NetInfo as unknown as { __emit(s: object): void }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed') }))
    await startSyncProbe() // unreached: NetInfo is watched
    net.__emit({ isConnected: true, isInternetReachable: true }) // stale: the next call asks again
    let fail!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((_, reject) => { fail = () => reject(new TypeError('Network request failed')) })))
    const inFlight = syncOn()
    await Promise.resolve()
    net.__emit({ isConnected: true, isInternetReachable: true }) // online again while that probe is in flight
    fail()
    expect(await inFlight).toBe(false)
    fakeApi({ 'GET /status': [{ status: 200, body: { maxPartBytes: 1024 } }] })
    expect(await syncOn()).toBe(true)
  })

  // #1143 review: a cancel during the re-hash after content_mismatch removes the book it imported.
  it('a cancel during the content_mismatch re-hash removes the imported book', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls, [conflict('content_mismatch')]))
    let hashes = 0
    const device: UploadIo = {
      ...io(),
      yieldNow: async () => {
        if (calls.some((c) => c.method === 'POST')) hashes++ // only the re-hash, after complete answered
        if (hashes > 0) throw Object.assign(new Error('Upload cancelled'), { aborted: true })
      },
    }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 25, device)).rejects.toMatchObject({ aborted: true })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: put.path })
  })

  // #1143: Cancel during the hash stops within one chunk, before any request.
  it('a cancel during hashing stops after the current chunk', async () => {
    const big = new Uint8Array(4 * 1024 * 1024)
    let reads = 0
    let cancelled = false
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const device: UploadIo = {
      ...deviceUploadIo(() => cancelled),
      open: () => ({ size: big.length, read: (at, n) => { reads++; cancelled = true; return big.subarray(at, at + n) }, close: () => {} }),
    }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 10, device)).rejects.toMatchObject({ aborted: true })
    expect(reads).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a write that knows no percent yet keeps the fraction the server holds', async () => {
    await setUserBookSyncState('b1', { revision: 2, fileId: 'f1', bookFraction: 0.6 })
    const calls = fakeApi({ 'PUT /books/b1/reading-state': [{ status: 200, body: { bookId: 'b1', fileId: 'f1', revision: 3, bookFraction: 0.6 } }] })
    expect(await saveProgress('b1', { chapterSlug: 'k1' })).toBe('accepted')
    expect(calls[0].body).toMatchObject({ expectedRevision: 2, bookFraction: 0.6 })
  })

  it('a cancelled upload removes the book it imported', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const cancelled: UploadIo = { ...io(), sendPart: async () => { throw Object.assign(new Error('Upload cancelled'), { aborted: true }) } }
    await expect(uploadBook({ uri: 'u', name: 'a.epub' }, 10, cancelled)).rejects.toMatchObject({ aborted: true })
    const put = calls.find((c) => c.method === 'PUT')!
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: put.path })
  })

  it('hashes the file streamed, imports, sends parts by the server size and completes', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const sent: Uint8Array[] = []
    const result = await uploadBook({ uri: 'file:///book.epub', name: 'My Book.epub' }, 10, io(sent))
    expect(result.existing).toBe(false)
    expect(sent.map((p) => p.length)).toEqual([10, 10, 5])
    const put = calls.find((c) => c.method === 'PUT' && c.path.startsWith('/books/'))!
    expect(put.body).toMatchObject({ title: 'My Book', file: { sha256: sha, byteSize: 25, format: 'epub' } })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { partCount: 3 } })
  })

  it('a picked book is uploaded from its staged copy with what the page read from it; the copy is gone either way (#1426)', async () => {
    const calls: Call[] = []
    vi.stubGlobal('fetch', wrapIds(calls))
    const staged = new Set<string>()
    const staging: UploadStaging = {
      copyIn: async () => { staged.add('staging/1.epub'); return { name: 'staging/1.epub', uri: 'file:///v2/staging/1.epub' } },
      remove: (name) => { staged.delete(name) },
    }
    const opened: string[] = []
    const device: UploadIo = { ...io(), open: (uri) => { opened.push(uri); return io().open(uri) } }
    const meta = { title: 'Moby-Dick', author: 'Herman Melville', lang: 'en', description: 'A whale.' }
    const read: string[] = []
    const describe = async (name: string) => { read.push(name); return { meta, cover: null } }

    await uploadPicked({ uri: 'content://picked', name: 'moby_dick (1).epub' }, 25, device, staging, describe)
    expect(opened).toEqual(['file:///v2/staging/1.epub'])
    expect(read).toEqual(['staging/1.epub'])
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ title: 'Moby-Dick', author: 'Herman Melville', language: 'en', description: 'A whale.' })
    expect(staged.size).toBe(0)

    // A failed upload (the server down on the import) still deletes the copy.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })))
    await expect(uploadPicked({ uri: 'content://picked', name: 'a.epub' }, 25, device, staging, describe)).rejects.toBeTruthy()
    expect(staged.size).toBe(0)
  })

  it('the upload screen offers all six formats, in its picker and its words', () => {
    expect(Object.keys(PICKER_TYPES_BY_FORMAT).sort()).toEqual(['azw3', 'cbz', 'epub', 'fb2', 'mobi', 'pdf'])
    for (const types of Object.values(PICKER_TYPES_BY_FORMAT)) for (const t of types) expect(UPLOAD_PICKER_TYPES).toContain(t)
    for (const f of Object.keys(PICKER_TYPES_BY_FORMAT)) expect(en.myBooks.upload.formats).toContain(f.toUpperCase())
  })

  it('sends the bytes to a book imported elsewhere without them', async () => {
    fakeApi({
      ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-meta', currentFile: { id: 'f-meta', hasContent: false } } }],
      'POST /books/b-meta/files/f-meta/content': [{ status: 200, body: {} }],
    })
    const sent: Uint8Array[] = []
    expect(await uploadBook({ uri: 'u', name: 'a.epub' }, 25, io(sent))).toEqual({ bookId: 'b-meta', existing: false })
    expect(sent).toHaveLength(1)
  })

  it('opens the book that already has these bytes instead of importing', async () => {
    const calls = fakeApi({ ['GET /books/by-sha256/' + sha]: [{ status: 200, body: { id: 'b-old', currentFile: { id: 'f', hasContent: true } } }] })
    expect(await uploadBook({ uri: 'u', name: 'a.epub' }, 10, io())).toEqual({ bookId: 'b-old', existing: true })
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('re-sends every part once after incomplete_upload, and names the quota', async () => {
    vi.stubGlobal('fetch', wrapIds([], [
      { status: 400, body: { code: 'incomplete_upload', message: 'x' } },
      { status: 200, body: {} },
    ]))
    const sent: Uint8Array[] = []
    await uploadBook({ uri: 'u', name: 'a.pdf' }, 25, io(sent))
    expect(sent).toHaveLength(2)

    resetSyncForTests()
    vi.stubGlobal('fetch', wrapIds([], [{ status: 409, body: { code: 'quota_exceeded', message: 'x', current: { used: 1, limit: 2 } } }]))
    await expect(uploadBook({ uri: 'u', name: 'a.pdf' }, 25, io())).rejects.toBeInstanceOf(FileUploadError)
  })

  it('caps a device part at 8 MB whatever the server takes (RN sends it as base64)', async () => {
    const big = new Uint8Array(MAX_DEVICE_PART_BYTES * 2 + 1)
    const sizes: number[] = []
    vi.stubGlobal('fetch', wrapIds([]))
    await uploadBook({ uri: 'u', name: 'big.pdf' }, 80 * 1024 * 1024, {
      open: () => ({ size: big.length, read: (at, n) => big.subarray(at, at + n), close: () => {} }),
      sendPart: async (_b, _f, _i, part) => { sizes.push(part.length) },
      yieldNow: async () => {},
    })
    expect(sizes).toEqual([MAX_DEVICE_PART_BYTES, MAX_DEVICE_PART_BYTES, 1])
  })

  it('streams the hash in chunks to the same digest', async () => {
    const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 13) & 0xff)
    const hex = await sha256Of({ size: big.length, read: (at, n) => big.subarray(at, at + n), close: () => {} }, async () => {})
    expect(hex).toBe(createHash('sha256').update(big).digest('hex'))
  })

  it('a lost reading-state write adopts the server place as this device record', async () => {
    await setUserBookSyncState('b1', { revision: 3, fileId: 'f1' })
    const current = state('b1', 5, { bookFraction: 0.4, currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 9 } } })
    const calls = fakeApi({ 'PUT /books/b1/reading-state': [conflict('stale_revision', { current })] })
    expect(await saveProgress('b1', { chapterSlug: null, locator: 'page:2', percent: 0.1 })).toEqual({ adopted: expect.objectContaining({ locator: 'page:9' }) })
    expect(calls[0].body).toMatchObject({ expectedRevision: 3, fileId: 'f1', currentLocator: { scheme: 'pdf-page', value: { page: 2 } } })
    expect(await getUserBookSyncState('b1')).toEqual({ revision: 5, fileId: 'f1', bookFraction: 0.4 })
    expect(await getUserBookLocalProgress('b1')).toMatchObject({ page: 9, bookPercent: 0.4, synced: true })
  })

  it('a replaced file forgets the book and asks for a reload; a missing chapter drops the write', async () => {
    await setUserBookSyncState('b1', { revision: 1, fileId: 'f1' })
    fakeApi({ 'PUT /books/b1/reading-state': [
      conflict('chapter_not_found'),
      conflict('file_replaced'),
    ] })
    expect(await saveProgress('b1', { chapterSlug: 'k1' })).toBe('dropped')
    expect(await saveProgress('b1', { chapterSlug: 'k1' })).toBe('reload')
    expect(await getUserBookSyncState('b1')).toBeNull()
  })
})

/**
 * The upload mints its own book and file ids; this fake answers every import, part and complete
 * whatever they are, and gives `completes` to the content route in turn.
 */
function wrapIds(calls: Call[], completes: Answer[] = [{ status: 200, body: {} }]) {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace(V2, '')
    const method = init.method ?? 'GET'
    calls.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body })
    let a: Answer = { status: 200, body: {} }
    if (path.startsWith('/books/by-sha256/')) a = { status: 404 }
    else if (method === 'PUT' && /^\/books\/[^/]+$/.test(path)) {
      // The import answers the book with its first file, no bytes yet.
      const sent = JSON.parse(init.body as string)
      a = { status: 201, body: { id: path.slice(7), currentFile: { id: sent.file.id, hasContent: false } } }
    }
    else if (method === 'POST' && path.endsWith('/content')) a = completes.length > 1 ? completes.shift()! : completes[0]
    return { ok: a.status < 300, status: a.status, text: async () => (a.body === undefined ? '' : JSON.stringify(a.body)) }
  })
}
