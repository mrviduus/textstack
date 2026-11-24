import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startSyncProbe, syncSwitch, resetSyncForTests, uploadBook, FileUploadError, saveProgress, readBookProgress,
  pullBooks, getShelfBooks, getBookDetail, syncStore, completeBook, uncompleteBook, bookChapters, rememberReadingState, fetchFileBytes,
} from '../sync'
import { getUserBook, getUserBookFileUrl, bulkFinishUserBooks } from '../userBooks'
import { fakeApi, asFake, SYNC_ON, book, file, feed, conflict, state, position, resetMidCall, type Answer } from '../../../../../packages/shared/src/api/__tests__/fakeSyncApi'
// The reader page is not in jsdom: no details read, as when it fails.
vi.mock('../../lib/describeBook', () => ({ describeBook: async () => null }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetSyncForTests()
})

describe('the V2 probe', () => {
  it('turns V2 on with the server part size on 200, once per app start', async () => {
    const calls = fakeApi(SYNC_ON)
    await startSyncProbe()
    await startSyncProbe()
    expect(await syncSwitch()).toEqual({ enabled: true, maxPartBytes: 1024 })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a 404 (flag off)', { status: 404 }],
    ['a 503 (V2 unavailable)', conflict('v2_unavailable', {}, 503)],
  ])('stays off for the app start on %s', async (_name, answer) => {
    fakeApi({ 'GET /me/v2/status': [answer] })
    expect((await startSyncProbe()).enabled).toBe(false)
  })

  it('stays off when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect((await startSyncProbe()).enabled).toBe(false)
  })

  it('asks again with the next session after a 401 (no session yet)', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 401 }, { status: 200, body: { maxPartBytes: 9 } }] })
    expect((await startSyncProbe()).enabled).toBe(false)
    expect((await startSyncProbe()).enabled).toBe(true)
  })

  it('makes a call before the session bootstrap settles wait for the probe instead of answering off', async () => {
    resetSyncForTests() // a fresh app start: the bootstrap has not settled
    fakeApi(SYNC_ON)
    const early = syncSwitch()
    await startSyncProbe()
    expect((await early).enabled).toBe(true)
  })
})

describe('the V2 library', () => {
  beforeEach(async () => {
    fakeApi(SYNC_ON)
    await startSyncProbe()
  })

  it('shares one in-flight pull between concurrent callers', async () => {
    const calls = fakeApi({ 'GET /me/v2/library/changes': feed(book('b0', 'f0')) })
    await Promise.all([pullBooks(), pullBooks()])
    expect(calls).toHaveLength(1)
  })

  it("reads the shelf from the two feeds alone: a book is ready when its file's bytes are in (ADR-033)", async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(
        book('ready', 'f1', { currentFile: file('f1', { chapterCount: 3 }) }),
        book('no-toc', 'f2'),
        book('no-bytes', 'f3', { currentFile: file('f3', { hasContent: false }) }),
        book('mobi', 'f5', { currentFile: file('f5', { format: 'mobi' }) }),
      ),
      'GET /me/v2/reading/changes': feed(),
    })
    const shelf = await getShelfBooks()
    expect(shelf.map((b) => [b.id, b.status, b.chapterCount, b.totalWordCount])).toEqual([
      ['ready', 'Ready', 3, null], ['no-toc', 'Ready', 0, null], ['no-bytes', 'Failed', 0, null], ['mobi', 'Ready', 0, null],
    ])
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/me/v2/library/changes', '/me/v2/reading/changes'])
  })

  it("resumes an epub-cfi on the shelf by a TOC this tab already read, and asks for none", async () => {
    const cfi = { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' }
    const calls = fakeApi({
      'GET /me/v2/library/changes': [...feed(book('b1', 'f1')), ...feed(book('b1', 'f1'))],
      'GET /me/v2/reading/changes': [...feed(state('b1', 1, { currentLocator: cfi })), ...feed(state('b1', 1, { currentLocator: cfi }))],
    })
    expect((await getShelfBooks())[0].progressChapterSlug).toBeNull()
    syncStore.chapters.set('f1', { items: [{ chapterKey: 'one', chapterNumber: 1, title: 'One' }, { chapterKey: 'two', chapterNumber: 2, title: 'Two' }] })
    expect((await getShelfBooks())[0].progressChapterSlug).toBe('two')
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })

  it('shows a book finished on the shelf from the reading feed (#1266), with its real fraction', async () => {
    fakeApi({
      'GET /me/v2/library/changes': feed(book('done', 'f1'), book('open', 'f2')),
      'GET /me/v2/reading/changes': feed(state('done', 3, { completedAt: '2026-11-13T10:00:00Z', bookFraction: 0.97 }), state('open', 1)),
    })
    expect((await getShelfBooks()).map((b) => [b.id, b.completedAt, b.progressPercent])).toEqual([['done', '2026-11-13T10:00:00Z', 0.97], ['open', null, 0.7]])
  })

  it('takes a user-book read to V2, with its cover as the API route', async () => {
    fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f1', { hasCover: true })),
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [] } }],
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 2, { completedAt: '2026-11-02T00:00:00Z', fileId: 'f1' }) }],
    })
    const detail = await getUserBook('b1')
    expect(detail).toMatchObject({ id: 'b1', completedAt: '2026-11-02T00:00:00Z', coverPath: expect.stringContaining('/me/v2/books/b1/cover?v=') })
    expect(getUserBookFileUrl('b1')).toBe('http://localhost:8080/me/v2/books/b1/files/f1/content')
  })

  it("never serves the previous account's book after a reset (sign-out)", async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('a-book', 'fa')), 'GET /me/v2/books/a-book/files/fa/chapters': [{ status: 200, body: { items: [] } }] })
    await pullBooks()
    syncStore.reset()
    fakeApi({ 'GET /me/v2/library/changes': feed() })
    await expect(getBookDetail('a-book')).rejects.toMatchObject({ status: 404 })
  })
})

describe('the V2 upload', () => {
  const B = '00000000-0000-4000-8000-00000000b001'
  const F = '00000000-0000-4000-8000-00000000f001'
  // sha256 of the bytes 1..5, the fixture file below.
  const SHA = '74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0'
  const lookup = `GET /me/v2/books/by-sha256/${SHA}`
  const content = (b: string, f: string) => `POST /me/v2/books/${b}/files/${f}/content`

  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(B).mockReturnValueOnce(F)
  })

  const epub = () => new File([new Uint8Array([1, 2, 3, 4, 5])], 'My Book.epub')
  const parts = () => {
    const sent: { url: string; size: number }[] = []
    return { sent, send: async (url: string, part: Blob) => { sent.push({ url, size: part.size }) } }
  }

  it('hashes, imports the metadata, sends the parts by the server size and completes', async () => {
    const calls = fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [{ status: 200, body: file(F) }] })
    const { sent, send } = parts()

    const result = await uploadBook(epub(), 2, send)

    expect(result).toMatchObject({ userBookId: B, status: 'Processing', hasOriginalPdf: false })
    expect(calls[1].body).toEqual({ title: 'My Book', file: { id: F, sha256: SHA, byteSize: 5, originalName: 'My Book.epub', format: 'epub' } })
    expect(sent.map((p) => [p.url.split('/parts/')[1], p.size])).toEqual([['0', 2], ['1', 2], ['2', 1]])
    expect(calls[2].body).toEqual({ partCount: 3 })
  })

  it('opens the book that already has these bytes', async () => {
    fakeApi({ [lookup]: [{ status: 200, body: book('old', 'f-old') }] })
    expect(await uploadBook(epub(), 2, parts().send)).toMatchObject({ userBookId: 'old', existing: true })
  })

  it('opens the existing book on duplicate_file', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [conflict('duplicate_file', { current: book('twin', 'f-twin') })] })
    expect(await uploadBook(epub(), 2, parts().send)).toMatchObject({ userBookId: 'twin', existing: true })
  })

  it.each([
    ['the sha256 lookup', (b: unknown) => ({ [lookup]: [{ status: 200, body: b }] })],
    ['duplicate_file', (b: unknown) => ({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [conflict('duplicate_file', { current: b })] })],
  ])('sends the bytes to a book whose earlier upload broke, found by %s, then opens it', async (_name, routes) => {
    const broken = book('broken', 'f-broken', { currentFile: file('f-broken', { hasContent: false }) })
    const calls = fakeApi({ ...routes(broken), [content('broken', 'f-broken')]: [{ status: 200, body: file('f-broken') }] })
    const { sent, send } = parts()

    expect(await uploadBook(epub(), 5, send)).toMatchObject({ userBookId: 'broken', existing: true })
    expect(sent.map((p) => p.url)).toEqual([expect.stringContaining('/books/broken/files/f-broken/parts/0')])
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', path: '/me/v2/books/broken/files/f-broken/content', body: { partCount: 1 } })
  })

  it('re-sends every part once on incomplete_upload, then completes', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('incomplete_upload', {}, 400), { status: 200, body: file(F) }] })
    const { sent, send } = parts()
    await uploadBook(epub(), 5, send)
    expect(sent).toHaveLength(2)
  })

  it('re-hashes on content_mismatch, sends once more, and tells the reader if it fails again', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('content_mismatch', {}, 422)] })
    const { sent, send } = parts()
    const error = await uploadBook(epub(), 5, send).catch((e) => e)
    expect(error).toBeInstanceOf(FileUploadError)
    expect(error.code).toBe('content_mismatch')
    expect(sent).toHaveLength(2)
  })

  it('carries used and limit on quota_exceeded', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('quota_exceeded', { current: { used: 9, limit: 10 } }, 413)] })
    const error = await uploadBook(epub(), 5, parts().send).catch((e) => e)
    expect(error).toMatchObject({ code: 'quota_exceeded', quota: { used: 9, limit: 10 } })
  })
})

describe('the V2 reading state', () => {
  const write = { chapterSlug: 'two', percent: 0.5, updatedAt: '2026-11-02T00:00:00.000Z', positionJson: JSON.stringify(position) }
  const put = 'PUT /me/v2/books/b1/reading-state'
  const library = { 'GET /me/v2/library/changes': feed(book('b1', 'f1')) }

  it("makes the first write a null revision on the current file, with the reader's TextPosition, and the next on the revision it got", async () => {
    const calls = fakeApi({ ...library, [put]: [{ status: 200, body: state('b1', 1) }, { status: 200, body: state('b1', 2) }] })
    expect(await saveProgress('b1', write)).toBe('accepted')
    await saveProgress('b1', write)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts[0].body).toMatchObject({ expectedRevision: null, fileId: 'f1', bookFraction: 0.5, currentLocator: { scheme: 'textstack-position-v1', value: position } })
    expect(puts[1].body).toMatchObject({ expectedRevision: 1 })
  })

  it('keeps the fraction the server holds when a write knows no percent yet (never 0 over it)', async () => {
    const calls = fakeApi({ ...library, [put]: [{ status: 200, body: state('b1', 1) }, { status: 200, body: state('b1', 2) }] })
    await saveProgress('b1', write)
    await saveProgress('b1', { ...write, percent: undefined })
    const held = state('b1', 1).bookFraction
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ bookFraction: held })
    expect(held).toBeGreaterThan(0)
  })

  it("adopts the server's place on stale_revision and writes on its revision next", async () => {
    const theirs = { ...position, chapterSlug: 'three' }
    const calls = fakeApi({ ...library, [put]: [conflict('stale_revision', { current: state('b1', 5, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: theirs } }) }), { status: 200, body: state('b1', 6) }] })
    expect(await saveProgress('b1', write)).toEqual({ adopted: expect.objectContaining({ chapterSlug: 'three', percent: 0.7, positionJson: JSON.stringify(theirs) }) })
    await saveProgress('b1', write)
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ expectedRevision: 5 })
  })

  it('writes its own place again on the revision a reset made', async () => {
    const calls = fakeApi({ ...library, [put]: [conflict('reset', { current: state('b1', 9, { resetRevision: 9 }) }), { status: 200, body: state('b1', 10) }] })
    expect(await saveProgress('b1', write)).toBe('accepted')
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([null, 9])
  })

  it.each([
    ['file_replaced', 'reload'],
    ['chapter_not_found', 'dropped'],
  ])('answers %s with %s', async (code, outcome) => {
    fakeApi({ ...library, [put]: [conflict(code)] })
    expect(await saveProgress('b1', write)).toBe(outcome)
  })

  it('refetches the book once on unknown_file and writes to its file', async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': [...feed(book('b1', 'f-old')), ...feed(book('b1', 'f-new'))],
      [put]: [conflict('unknown_file'), { status: 200, body: state('b1', 1) }],
    })
    expect(await saveProgress('b1', write)).toBe('accepted')
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.fileId)).toEqual(['f-old', 'f-new'])
  })

  it('writes a state read on a superseded file to the current file, as a first write (no reload loop)', async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f-new')),
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 3, { fileId: 'f-old' }) }],
      [put]: [{ status: 200, body: state('b1', 1, { fileId: 'f-new' }) }],
    })
    await pullBooks()
    await readBookProgress('b1')
    expect(await saveProgress('b1', write)).toBe('accepted')
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ fileId: 'f-new', expectedRevision: null })
  })

  it('reads a pdf-page place back as page:N, and an epub-cfi by its fraction over the TOC entries', async () => {
    fakeApi({
      ...library,
      'GET /me/v2/books/b1/reading-state': [
        { status: 200, body: state('b1', 1, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 12 } } }) },
        { status: 200, body: state('b1', 1, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' } }) },
      ],
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [{ chapterKey: 'one' }, { chapterKey: 'two' }] } }],
    })
    expect(await readBookProgress('b1')).toMatchObject({ chapterSlug: null, locator: 'page:12' })
    expect(await readBookProgress('b1')).toMatchObject({ chapterSlug: 'two', positionJson: null, percent: 0.7 })
  })

  it('marks a book read with completedAt on its place, and unread by a reset', async () => {
    const calls = fakeApi({
      ...library,
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [{ chapterKey: 'one' }] } }],
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 4) }],
      [put]: [{ status: 200, body: state('b1', 5) }],
      'POST /me/v2/books/b1/reading-state/reset': [{ status: 200, body: state('b1', 6) }],
    })
    await completeBook('b1')
    await uncompleteBook('b1')
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ expectedRevision: 4, fileId: 'f1', completedAt: expect.any(String), currentLocator: { value: position } })
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedRevision: 4 })
  })
})

describe('an answer that outlives a sign-out (syncStore.reset, #1155)', () => {
  beforeEach(async () => {
    fakeApi(SYNC_ON)
    await startSyncProbe()
  })

  const library = { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }
  const chapters = { 'GET /me/v2/books/b1/files/f1/chapters': { status: 200, body: { items: [{ chapterKey: 'one', chapterNumber: 0, title: 'One' }] } } }
  const put = { 'PUT /me/v2/books/b1/reading-state': { status: 200, body: state('b1', 1) } }
  const write = { chapterSlug: 'two', percent: 0.5, positionJson: JSON.stringify(position) }
  const underReset = <T>(routes: Record<string, Answer>, op: () => Promise<T>, hold?: string) =>
    resetMidCall(() => syncStore.reset(), routes, op, hold)
  /** Every request answers an empty chapter list, and the one to `path` resets the store first: a sign-out mid-call. */
  const resetOn = (path: string) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes(path)) syncStore.reset()
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) }
  }))

  it('keeps no books from a library pull answered after the reset', async () => {
    await underReset(library, () => pullBooks())
    expect(syncStore.books.size).toBe(0)
  })

  it('keeps the books of a library pull answered with no reset', async () => {
    asFake(library)
    await pullBooks()
    expect([...syncStore.books.keys()]).toEqual(['b1'])
  })

  it('caches no chapters answered after the reset', async () => {
    await underReset(chapters, () => bookChapters(book('b1', 'f1') as never))
    expect(syncStore.chapters.size).toBe(0)
  })

  it('caches the chapters answered with no reset', async () => {
    asFake(chapters)
    await bookChapters(book('b1', 'f1') as never)
    expect([...syncStore.chapters.keys()]).toEqual(['f1'])
  })

  it('drops a reading-state write answered after the reset, remembering no revision', async () => {
    expect(await underReset({ ...library, ...put }, () => saveProgress('b1', write), '/reading-state')).toBe('dropped')
    expect(syncStore.states.size).toBe(0)
  })

  it('remembers the revision of a reading-state write answered with no reset', async () => {
    asFake({ ...library, ...put })
    expect(await saveProgress('b1', write)).toBe('accepted')
    expect(syncStore.states.get('b1')).toMatchObject({ revision: 1 })
  })

  it("adopts no server place from a conflict answered after the reset", async () => {
    const lost = { 'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current: state('b1', 5) }) }
    expect(await underReset({ ...library, ...lost }, () => saveProgress('b1', write), '/reading-state')).toBe('dropped')
    expect(syncStore.states.size).toBe(0)
  })

  const cfi = { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' } }
  const readState = (answer: Answer) => ({ 'GET /me/v2/books/b1/reading-state': answer })

  it('answers a read that lands after the reset as no answer, not as no state', async () => {
    expect(await underReset(readState({ status: 404 }), () => readBookProgress('b1'))).toBeUndefined()
  })

  it('answers a read of no state with no reset as no state', async () => {
    asFake(readState({ status: 404 }))
    expect(await readBookProgress('b1')).toBeNull()
  })

  it('answers no place when the reset lands while a read resolves its chapter', async () => {
    const routes = { ...library, ...chapters, ...readState({ status: 200, body: state('b1', 1, cfi) }) }
    expect(await underReset(routes, () => readBookProgress('b1'), '/chapters')).toBeUndefined()
  })

  it("adopts no server place when the reset lands while a lost write resolves the server's chapter", async () => {
    const lost = { 'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current: state('b1', 5, cfi) }) }
    expect(await underReset({ ...library, ...chapters, ...lost }, () => saveProgress('b1', write), '/chapters')).toBe('dropped')
  })

  it('sends no mark-read write once the reset landed', async () => {
    // Its state is on the current file, so no TOC is read (#1121 review): the reset lands on the state read.
    const routes = { ...library, ...readState({ status: 200, body: state('b1', 4) }), ...put }
    expect(await underReset(routes, () => completeBook('b1'), '/reading-state')).toBe('dropped')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it("answers a mark-read whose state read lands after the reset as dropped, not as 'nothing to mark'", async () => {
    expect(await underReset({ ...library, ...readState({ status: 404 }) }, () => completeBook('b1'), '/reading-state')).toBe('dropped')
  })

  it('marks a book read with no reset', async () => {
    asFake({ ...library, ...chapters, ...readState({ status: 200, body: state('b1', 4) }), ...put })
    expect(await completeBook('b1')).toBe('done')
  })

  it('marks no book unread when its reset is answered after the sign-out', async () => {
    const routes = { ...readState({ status: 200, body: state('b1', 4) }), 'POST /me/v2/books/b1/reading-state/reset': { status: 200, body: state('b1', 5) } }
    expect(await underReset(routes, () => uncompleteBook('b1'), '/reading-state/reset')).toBe('dropped')
  })

  it('sends no mark-unread write once the reset landed during the state read', async () => {
    resetOn('/reading-state')
    expect(await uncompleteBook('b1')).toBe('dropped')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails every book left in a bulk mark-read once one was dropped', async () => {
    asFake({ 'GET /me/v2/library/changes': feed(book('b1', 'f1'), book('b2', 'f2'))[0] })
    await pullBooks()
    resetOn('/reading-state')
    expect(await bulkFinishUserBooks(['b1', 'b2'], true)).toEqual({
      succeeded: [], failed: [{ id: 'b1', reason: 'dropped' }, { id: 'b2', reason: 'dropped' }],
    })
  })

  it('marks a book unread with no reset', async () => {
    asFake({ ...readState({ status: 200, body: state('b1', 4) }), 'POST /me/v2/books/b1/reading-state/reset': { status: 200, body: state('b1', 5) } })
    expect(await uncompleteBook('b1')).toBe('done')
  })

  it('remembers no revision from a keepalive answer that lands after the reset', async () => {
    let land!: (s: never) => void
    const answer = rememberReadingState(new Promise((r) => { land = r }))
    syncStore.reset()
    land(state('b1', 1) as never)
    expect(await answer).toBeNull()
    expect(syncStore.states.size).toBe(0)
  })

  it('remembers the revision of a keepalive answer with no reset', async () => {
    await rememberReadingState(Promise.resolve(state('b1', 1) as never))
    expect(syncStore.states.get('b1')).toMatchObject({ revision: 1 })
  })
})

// #1225: the V2 reader's bytes, online, cookie-authed, authFetch's 401 rule.
describe('fetchFileBytes', () => {
  const CONTENT = '/me/v2/books/b1/files/f1/content'
  /** `fetch` by path: each path answers its statuses in order (the last one repeats). */
  function stubFetch(answers: Record<string, number[]>) {
    const f = vi.fn(async (url: string) => {
      const path = Object.keys(answers).find((p) => url.endsWith(p))!
      const status = answers[path].length > 1 ? answers[path].shift()! : answers[path][0]
      return new Response(status === 200 ? (path === CONTENT ? 'BYTES' : '{}') : null, { status })
    })
    vi.stubGlobal('fetch', f)
    return f
  }

  it('returns the content bytes, with the cookie', async () => {
    const f = stubFetch({ [CONTENT]: [200] })
    expect(new TextDecoder().decode(await fetchFileBytes('b1', 'f1'))).toBe('BYTES')
    expect(f).toHaveBeenCalledWith(expect.stringMatching(/\/me\/v2\/books\/b1\/files\/f1\/content$/), expect.objectContaining({ credentials: 'include' }))
  })

  it('offline is the client network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchFileBytes('b1', 'f1')).rejects.toMatchObject({ status: 0, isNetworkError: true })
  })

  it('refreshes the cookie once on a 401 and retries', async () => {
    const f = stubFetch({ [CONTENT]: [401, 200], '/auth/refresh': [200] })
    expect(new TextDecoder().decode(await fetchFileBytes('b1', 'f1'))).toBe('BYTES')
    expect(f.mock.calls.map(([u]) => u.replace(/^.*?(\/me|\/auth)/, '$1'))).toEqual([CONTENT, '/auth/refresh', CONTENT])
  })

  it.each([404, 503])('throws an ApiError on a %i', async (status) => {
    stubFetch({ [CONTENT]: [status] })
    await expect(fetchFileBytes('b1', 'f1')).rejects.toMatchObject({ status })
  })

  it('a failed refresh is the 401, no retry', async () => {
    const f = stubFetch({ [CONTENT]: [401], '/auth/refresh': [401] })
    await expect(fetchFileBytes('b1', 'f1')).rejects.toMatchObject({ status: 401 })
    expect(f.mock.calls.filter(([u]) => u.endsWith(CONTENT))).toHaveLength(1)
  })
})
