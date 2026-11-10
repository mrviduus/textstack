import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startV2Probe, v2Status, onV2, resetV2ForTests, uploadV2Book, V2UploadError, saveV2Progress, readV2Progress,
  pullV2Books, getV2UserBooks, getV2UserBook, v2Store, completeV2Book, uncompleteV2Book, v2Chapters, rememberV2State,
} from '../v2'
import { getUserBook, getUserBooks, saveUserBookProgress, getUserBookFileUrl, getUserBookBookmarks } from '../userBooks'
import { getWords } from '../vocabulary'
import { fakeApi, V2_ON, book, file, feed, conflict, state, position, resetMidCall } from '../../../../../packages/shared/src/api/__tests__/fakeV2Api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetV2ForTests()
})

describe('the V2 probe', () => {
  it('turns V2 on with the server part size on 200, once per app start', async () => {
    const calls = fakeApi(V2_ON)
    await startV2Probe()
    await startV2Probe()
    expect(await v2Status()).toEqual({ enabled: true, maxPartBytes: 1024 })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['a 404 (flag off)', { status: 404 }],
    ['a 503 (V2 unavailable)', conflict('v2_unavailable', {}, 503)],
  ])('stays off for the app start on %s', async (_name, answer) => {
    fakeApi({ 'GET /me/v2/status': [answer] })
    expect((await startV2Probe()).enabled).toBe(false)
  })

  it('stays off when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect((await startV2Probe()).enabled).toBe(false)
  })

  it('asks again with the next session after a 401 (no session yet)', async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 401 }, { status: 200, body: { maxPartBytes: 9 } }] })
    expect((await startV2Probe()).enabled).toBe(false)
    expect((await startV2Probe()).enabled).toBe(true)
  })

  it('makes a call before the session bootstrap settles wait for the probe instead of answering off', async () => {
    resetV2ForTests() // a fresh app start: the bootstrap has not settled
    fakeApi(V2_ON)
    const early = onV2()
    await startV2Probe()
    expect(await early).toBe(true)
  })
})

describe('with V2 off, each call takes exactly its legacy route', () => {
  beforeEach(async () => {
    fakeApi({ 'GET /me/v2/status': [{ status: 404 }] })
    await startV2Probe()
  })

  it.each([
    ['getUserBook', () => getUserBook('b1'), 'GET /me/books/b1'],
    ['getUserBooks', () => getUserBooks(), 'GET /me/books'],
    ['getUserBookBookmarks', () => getUserBookBookmarks('b1'), 'GET /me/books/b1/bookmarks'],
    ['getWords', () => getWords(), 'GET /me/vocabulary/words'],
  ])('%s', async (_name, call, route) => {
    const calls = fakeApi({ [route]: [{ status: 200, body: [] }] })
    await call().catch(() => null)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([route])
  })

  it('saveUserBookProgress, with the legacy body', async () => {
    const calls = fakeApi({ 'PUT /me/books/b1/progress': [{ status: 200 }] })
    const body = { chapterSlug: 'one', locator: 'scroll:one:5', percent: 0.3, percentUnit: 'book', locatorKind: 'scroll', updatedAt: '2026-11-02T00:00:00.000Z' }
    expect(await saveUserBookProgress('b1', body)).toBeUndefined()
    expect(calls).toEqual([{ method: 'PUT', path: '/me/books/b1/progress', body }])
  })

  it('getUserBookFileUrl', () => {
    expect(getUserBookFileUrl('b1')).toBe('http://localhost:8080/me/books/b1/file')
  })
})

describe('the V2 library', () => {
  beforeEach(async () => {
    fakeApi(V2_ON)
    await startV2Probe()
  })

  it('shares one in-flight pull between concurrent callers', async () => {
    const calls = fakeApi({ 'GET /me/v2/library/changes': feed(book('b0', 'f0')) })
    await Promise.all([pullV2Books(), pullV2Books()])
    expect(calls).toHaveLength(1)
  })

  it("reads the shelf from the two feeds alone: each book's status and counts are its file's (#1118)", async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(
        book('ready', 'f1', { currentFile: file('f1', { ingestion: 'succeeded', chapterCount: 3, wordCount: 1200 }) }),
        book('running', 'f2', { currentFile: file('f2', { ingestion: 'processing' }) }),
        book('no-bytes', 'f3'),
        book('no-words', 'f4', { currentFile: file('f4', { ingestion: 'succeeded', chapterCount: 2 }) }),
      ),
      'GET /me/v2/reading/changes': feed(),
    })
    const shelf = await getV2UserBooks()
    expect(shelf.map((b) => [b.id, b.status, b.chapterCount, b.totalWordCount])).toEqual([
      ['ready', 'Ready', 3, 1200], ['running', 'Processing', 0, null], ['no-bytes', 'Failed', 0, null], ['no-words', 'Ready', 2, null],
    ])
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/me/v2/library/changes', '/me/v2/reading/changes'])
  })

  it("resumes an epub-cfi on the shelf by a TOC this tab already read, and asks for none", async () => {
    const cfi = { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' }
    const calls = fakeApi({
      'GET /me/v2/library/changes': [...feed(book('b1', 'f1')), ...feed(book('b1', 'f1'))],
      'GET /me/v2/reading/changes': [...feed(state('b1', 1, { currentLocator: cfi })), ...feed(state('b1', 1, { currentLocator: cfi }))],
    })
    expect((await getV2UserBooks())[0].progressChapterSlug).toBeNull()
    v2Store.chapters.set('f1', { items: [{ chapterKey: 'one', chapterNumber: 1, title: 'One', wordCount: 100 }, { chapterKey: 'two', chapterNumber: 2, title: 'Two', wordCount: 100 }], ingestion: 'succeeded' })
    expect((await getV2UserBooks())[0].progressChapterSlug).toBe('two')
    expect(calls.some((c) => c.path.includes('/chapters'))).toBe(false)
  })

  it('takes a user-book read to V2, with its cover as the API route', async () => {
    fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f1', { hasCover: true })),
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [], ingestion: 'succeeded' } }],
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 2, { completedAt: '2026-11-02T00:00:00Z', fileId: 'f1' }) }],
    })
    const detail = await getUserBook('b1')
    expect(detail).toMatchObject({ id: 'b1', completedAt: '2026-11-02T00:00:00Z', coverPath: expect.stringContaining('/me/v2/books/b1/cover?v=') })
    expect(getUserBookFileUrl('b1')).toBe('http://localhost:8080/me/v2/books/b1/files/f1/content')
  })

  it("never serves the previous account's book after a reset (sign-out)", async () => {
    fakeApi({ 'GET /me/v2/library/changes': feed(book('a-book', 'fa')), 'GET /me/v2/books/a-book/files/fa/chapters': [{ status: 200, body: { items: [], ingestion: 'succeeded' } }] })
    await pullV2Books()
    v2Store.reset()
    fakeApi({ 'GET /me/v2/library/changes': feed() })
    await expect(getV2UserBook('a-book')).rejects.toMatchObject({ status: 404 })
  })

  it('has no bookmarks for a V2 book, and asks no route for them', async () => {
    const calls = fakeApi({})
    expect(await getUserBookBookmarks('b1')).toEqual([])
    expect(calls).toHaveLength(0)
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

    const result = await uploadV2Book(epub(), 2, send)

    expect(result).toMatchObject({ userBookId: B, status: 'Processing', hasOriginalPdf: false })
    expect(calls[1].body).toEqual({ title: 'My Book', file: { id: F, sha256: SHA, byteSize: 5, originalName: 'My Book.epub', format: 'epub' } })
    expect(sent.map((p) => [p.url.split('/parts/')[1], p.size])).toEqual([['0', 2], ['1', 2], ['2', 1]])
    expect(calls[2].body).toEqual({ partCount: 3 })
  })

  it('opens the book that already has these bytes', async () => {
    fakeApi({ [lookup]: [{ status: 200, body: book('old', 'f-old') }] })
    expect(await uploadV2Book(epub(), 2, parts().send)).toMatchObject({ userBookId: 'old', existing: true })
  })

  it('opens the existing book on duplicate_file', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [conflict('duplicate_file', { current: book('twin', 'f-twin') })] })
    expect(await uploadV2Book(epub(), 2, parts().send)).toMatchObject({ userBookId: 'twin', existing: true })
  })

  it.each([
    ['the sha256 lookup', (b: unknown) => ({ [lookup]: [{ status: 200, body: b }] })],
    ['duplicate_file', (b: unknown) => ({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [conflict('duplicate_file', { current: b })] })],
  ])('sends the bytes to a book whose earlier upload broke, found by %s, then opens it', async (_name, routes) => {
    const broken = book('broken', 'f-broken', { currentFile: file('f-broken', { hasContent: false }) })
    const calls = fakeApi({ ...routes(broken), [content('broken', 'f-broken')]: [{ status: 200, body: file('f-broken') }] })
    const { sent, send } = parts()

    expect(await uploadV2Book(epub(), 5, send)).toMatchObject({ userBookId: 'broken', existing: true })
    expect(sent.map((p) => p.url)).toEqual([expect.stringContaining('/books/broken/files/f-broken/parts/0')])
    expect(calls[calls.length - 1]).toMatchObject({ method: 'POST', path: '/me/v2/books/broken/files/f-broken/content', body: { partCount: 1 } })
  })

  it('re-sends every part once on incomplete_upload, then completes', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('incomplete_upload', {}, 400), { status: 200, body: file(F) }] })
    const { sent, send } = parts()
    await uploadV2Book(epub(), 5, send)
    expect(sent).toHaveLength(2)
  })

  it('re-hashes on content_mismatch, sends once more, and tells the reader if it fails again', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('content_mismatch', {}, 422)] })
    const { sent, send } = parts()
    const error = await uploadV2Book(epub(), 5, send).catch((e) => e)
    expect(error).toBeInstanceOf(V2UploadError)
    expect(error.code).toBe('content_mismatch')
    expect(sent).toHaveLength(2)
  })

  it('carries used and limit on quota_exceeded', async () => {
    fakeApi({ [lookup]: [{ status: 404 }], [`PUT /me/v2/books/${B}`]: [{ status: 201, body: book(B, F) }], [content(B, F)]: [conflict('quota_exceeded', { current: { used: 9, limit: 10 } }, 413)] })
    const error = await uploadV2Book(epub(), 5, parts().send).catch((e) => e)
    expect(error).toMatchObject({ code: 'quota_exceeded', quota: { used: 9, limit: 10 } })
  })
})

describe('the V2 reading state', () => {
  const write = { chapterSlug: 'two', percent: 0.5, updatedAt: '2026-11-02T00:00:00.000Z', positionJson: JSON.stringify(position) }
  const put = 'PUT /me/v2/books/b1/reading-state'
  const library = { 'GET /me/v2/library/changes': feed(book('b1', 'f1')) }

  it("makes the first write a null revision on the current file, with the reader's TextPosition, and the next on the revision it got", async () => {
    const calls = fakeApi({ ...library, [put]: [{ status: 200, body: state('b1', 1) }, { status: 200, body: state('b1', 2) }] })
    expect(await saveV2Progress('b1', write)).toBe('accepted')
    await saveV2Progress('b1', write)
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts[0].body).toMatchObject({ expectedRevision: null, fileId: 'f1', bookFraction: 0.5, currentLocator: { scheme: 'textstack-position-v1', value: position } })
    expect(puts[1].body).toMatchObject({ expectedRevision: 1 })
  })

  it('keeps the fraction the server holds when a write knows no percent yet (never 0 over it)', async () => {
    const calls = fakeApi({ ...library, [put]: [{ status: 200, body: state('b1', 1) }, { status: 200, body: state('b1', 2) }] })
    await saveV2Progress('b1', write)
    await saveV2Progress('b1', { ...write, percent: undefined })
    const held = state('b1', 1).bookFraction
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ bookFraction: held })
    expect(held).toBeGreaterThan(0)
  })

  it("adopts the server's place on stale_revision and writes on its revision next", async () => {
    const theirs = { ...position, chapterSlug: 'three' }
    const calls = fakeApi({ ...library, [put]: [conflict('stale_revision', { current: state('b1', 5, { currentLocator: { version: 1, scheme: 'textstack-position-v1', value: theirs } }) }), { status: 200, body: state('b1', 6) }] })
    expect(await saveV2Progress('b1', write)).toEqual({ adopted: expect.objectContaining({ chapterSlug: 'three', percent: 0.7, positionJson: JSON.stringify(theirs) }) })
    await saveV2Progress('b1', write)
    expect(calls.filter((c) => c.method === 'PUT')[1].body).toMatchObject({ expectedRevision: 5 })
  })

  it('writes its own place again on the revision a reset made', async () => {
    const calls = fakeApi({ ...library, [put]: [conflict('reset', { current: state('b1', 9, { resetRevision: 9 }) }), { status: 200, body: state('b1', 10) }] })
    expect(await saveV2Progress('b1', write)).toBe('accepted')
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.expectedRevision)).toEqual([null, 9])
  })

  it.each([
    ['file_replaced', 'reload'],
    ['chapter_not_found', 'dropped'],
  ])('answers %s with %s', async (code, outcome) => {
    fakeApi({ ...library, [put]: [conflict(code)] })
    expect(await saveV2Progress('b1', write)).toBe(outcome)
  })

  it('refetches the book once on unknown_file and writes to its file', async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': [...feed(book('b1', 'f-old')), ...feed(book('b1', 'f-new'))],
      [put]: [conflict('unknown_file'), { status: 200, body: state('b1', 1) }],
    })
    expect(await saveV2Progress('b1', write)).toBe('accepted')
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body.fileId)).toEqual(['f-old', 'f-new'])
  })

  it('writes a state read on a superseded file to the current file, as a first write (no reload loop)', async () => {
    const calls = fakeApi({
      'GET /me/v2/library/changes': feed(book('b1', 'f-new')),
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 3, { fileId: 'f-old' }) }],
      [put]: [{ status: 200, body: state('b1', 1, { fileId: 'f-new' }) }],
    })
    await pullV2Books()
    await readV2Progress('b1')
    expect(await saveV2Progress('b1', write)).toBe('accepted')
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ fileId: 'f-new', expectedRevision: null })
  })

  it('reads a pdf-page place back as page:N, and an epub-cfi by its fraction over the word counts', async () => {
    fakeApi({
      ...library,
      'GET /me/v2/books/b1/reading-state': [
        { status: 200, body: state('b1', 1, { currentLocator: { version: 1, scheme: 'pdf-page', value: { page: 12 } } }) },
        { status: 200, body: state('b1', 1, { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' } }) },
      ],
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [{ chapterKey: 'one', wordCount: 100 }, { chapterKey: 'two', wordCount: 100 }], ingestion: 'succeeded' } }],
    })
    expect(await readV2Progress('b1')).toMatchObject({ chapterSlug: null, locator: 'page:12' })
    expect(await readV2Progress('b1')).toMatchObject({ chapterSlug: 'two', positionJson: null, percent: 0.7 })
  })

  it('marks a book read with completedAt on its place, and unread by a reset', async () => {
    const calls = fakeApi({
      ...library,
      'GET /me/v2/books/b1/files/f1/chapters': [{ status: 200, body: { items: [{ chapterKey: 'one', wordCount: 1 }], ingestion: 'succeeded' } }],
      'GET /me/v2/books/b1/reading-state': [{ status: 200, body: state('b1', 4) }],
      [put]: [{ status: 200, body: state('b1', 5) }],
      'POST /me/v2/books/b1/reading-state/reset': [{ status: 200, body: state('b1', 6) }],
    })
    await completeV2Book('b1')
    await uncompleteV2Book('b1')
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ expectedRevision: 4, fileId: 'f1', completedAt: expect.any(String), currentLocator: { value: position } })
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedRevision: 4 })
  })
})

describe('an answer that outlives a sign-out (v2Store.reset, #1155)', () => {
  beforeEach(async () => {
    fakeApi(V2_ON)
    await startV2Probe()
  })

  const library = { 'GET /me/v2/library/changes': feed(book('b1', 'f1'))[0] }
  const chapters = { 'GET /me/v2/books/b1/files/f1/chapters': { status: 200, body: { items: [], ingestion: 'succeeded' } } }
  const put = { 'PUT /me/v2/books/b1/reading-state': { status: 200, body: state('b1', 1) } }
  const write = { chapterSlug: 'two', percent: 0.5, positionJson: JSON.stringify(position) }
  const asFake = (routes: Record<string, { status: number; body?: unknown }>) =>
    fakeApi(Object.fromEntries(Object.entries(routes).map(([k, a]) => [k, [a]])))

  it('keeps no books from a library pull answered after the reset', async () => {
    await resetMidCall(() => v2Store.reset(), library, () => pullV2Books())
    expect(v2Store.books.size).toBe(0)
  })

  it('keeps the books of a library pull answered with no reset', async () => {
    asFake(library)
    await pullV2Books()
    expect([...v2Store.books.keys()]).toEqual(['b1'])
  })

  it('caches no chapters answered after the reset', async () => {
    await resetMidCall(() => v2Store.reset(), chapters, () => v2Chapters(book('b1', 'f1') as never))
    expect(v2Store.chapters.size).toBe(0)
  })

  it('caches the chapters answered with no reset', async () => {
    asFake(chapters)
    await v2Chapters(book('b1', 'f1') as never)
    expect([...v2Store.chapters.keys()]).toEqual(['f1'])
  })

  it('drops a reading-state write answered after the reset, remembering no revision', async () => {
    expect(await resetMidCall(() => v2Store.reset(), { ...library, ...put }, () => saveV2Progress('b1', write), '/reading-state')).toBe('dropped')
    expect(v2Store.states.size).toBe(0)
  })

  it('remembers the revision of a reading-state write answered with no reset', async () => {
    asFake({ ...library, ...put })
    expect(await saveV2Progress('b1', write)).toBe('accepted')
    expect(v2Store.states.get('b1')).toMatchObject({ revision: 1 })
  })

  it("adopts no server place from a conflict answered after the reset", async () => {
    const lost = { 'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current: state('b1', 5) }) }
    expect(await resetMidCall(() => v2Store.reset(), { ...library, ...lost }, () => saveV2Progress('b1', write), '/reading-state')).toBe('dropped')
    expect(v2Store.states.size).toBe(0)
  })

  const cfi = { currentLocator: { version: 1, scheme: 'epub-cfi', value: 'epubcfi(/6/4!/4)', quote: 'q' } }
  const readState = (answer: { status: number; body?: unknown }) => ({ 'GET /me/v2/books/b1/reading-state': answer })

  it('answers a read that lands after the reset as no answer, not as no state', async () => {
    expect(await resetMidCall(() => v2Store.reset(), readState({ status: 404 }), () => readV2Progress('b1'))).toBeUndefined()
  })

  it('answers a read of no state with no reset as no state', async () => {
    asFake(readState({ status: 404 }))
    expect(await readV2Progress('b1')).toBeNull()
  })

  it('answers no place when the reset lands while a read resolves its chapter', async () => {
    const routes = { ...library, ...chapters, ...readState({ status: 200, body: state('b1', 1, cfi) }) }
    expect(await resetMidCall(() => v2Store.reset(), routes, () => readV2Progress('b1'), '/chapters')).toBeUndefined()
  })

  it("adopts no server place when the reset lands while a lost write resolves the server's chapter", async () => {
    const lost = { 'PUT /me/v2/books/b1/reading-state': conflict('stale_revision', { current: state('b1', 5, cfi) }) }
    expect(await resetMidCall(() => v2Store.reset(), { ...library, ...chapters, ...lost }, () => saveV2Progress('b1', write), '/chapters')).toBe('dropped')
  })

  it('marks no book read when the reset lands before its write is answered', async () => {
    const routes = { ...library, ...chapters, ...readState({ status: 200, body: state('b1', 4) }), ...put }
    expect(await resetMidCall(() => v2Store.reset(), routes, () => completeV2Book('b1'), '/chapters')).toBe('dropped')
    expect(v2Store.states.size).toBe(0)
  })

  it('marks a book read with no reset', async () => {
    asFake({ ...library, ...chapters, ...readState({ status: 200, body: state('b1', 4) }), ...put })
    expect(await completeV2Book('b1')).toBe('done')
  })

  it('marks no book unread when its reset is answered after the sign-out', async () => {
    const routes = { ...readState({ status: 200, body: state('b1', 4) }), 'POST /me/v2/books/b1/reading-state/reset': { status: 200, body: state('b1', 5) } }
    expect(await resetMidCall(() => v2Store.reset(), routes, () => uncompleteV2Book('b1'), '/reading-state/reset')).toBe('dropped')
  })

  it('marks a book unread with no reset', async () => {
    asFake({ ...readState({ status: 200, body: state('b1', 4) }), 'POST /me/v2/books/b1/reading-state/reset': { status: 200, body: state('b1', 5) } })
    expect(await uncompleteV2Book('b1')).toBe('done')
  })

  it('remembers no revision from a keepalive answer that lands after the reset', async () => {
    let land!: (s: never) => void
    const answer = rememberV2State(new Promise((r) => { land = r }))
    v2Store.reset()
    land(state('b1', 1) as never)
    expect(await answer).toBeNull()
    expect(v2Store.states.size).toBe(0)
  })

  it('remembers the revision of a keepalive answer with no reset', async () => {
    await rememberV2State(Promise.resolve(state('b1', 1) as never))
    expect(v2Store.states.get('b1')).toMatchObject({ revision: 1 })
  })
})
