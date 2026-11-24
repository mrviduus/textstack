// The fork's PDF reader (makePDF, .vendor/foliate-js/pdf.js) over a pdf.js stand-in: what it asks of pdf.js and of
// its worker, and when it lets go of a page's blob: URL (#1204, #1557). formats.check.mjs opens real PDFs in Chromium.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real pdf.js is not loaded: the fork reads `globalThis.pdfjsLib`, set below before each import.
vi.mock('./.vendor/foliate-js/vendor/pdfjs/pdf.mjs', () => ({}))

const never = () => new Promise<never>(() => {})
type Fake = { webWorker: { terminate: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }; params: Record<string, unknown> | null; taskDestroy: ReturnType<typeof vi.fn> }

/** pdf.js as the fork uses it: `doc` answers what the test says (a page, metadata, an outline), the task its load. */
function fakePdfjs(fake: Fake, { load = Promise.resolve(null as unknown), getPage = (i: number) => Promise.resolve(page(i)) as Promise<unknown>, getOutline = vi.fn(() => Promise.resolve([{ title: 'One', dest: [{ num: 1 }], items: [] }])) } = {}) {
  const doc = { numPages: 12, getMetadata: () => Promise.resolve({}), getOutline, getPage, destroy: () => Promise.resolve() }
  ;(globalThis as any).pdfjsLib = {
    GlobalWorkerOptions: { workerSrc: '' },
    PDFWorker: class { constructor(public opts: unknown) {} destroy() {} },
    getDocument(params: Record<string, unknown>) {
      fake.params = params
      return { promise: load.then(() => doc), destroy: fake.taskDestroy }
    },
  }
  return doc
}
const page = (i: number) => ({ i, getViewport: () => ({ width: 600, height: 800 }), cleanup: vi.fn() })

const vendored = existsSync(resolve(__dirname, '.vendor/foliate-js/pdf.js'))

describe.skipIf(!vendored)('the fork PDF reader (makePDF)', () => {
  let fake: Fake
  let made: string[]
  let revoked: string[]
  beforeEach(() => {
    vi.resetModules()
    fake = { webWorker: { terminate: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }, params: null, taskDestroy: vi.fn(() => Promise.resolve()) }
    made = []
    revoked = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { made.push(`blob:${made.length}`); return made.at(-1)! })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u) })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  const makePDF = async (bytes: Uint8Array, opts: Record<string, unknown>) => {
    // @ts-ignore — .vendor/ is the build-time clone (gitignored); the skipIf keeps CI (no clone at test time) from running this.
    const { makePDF } = await import('./.vendor/foliate-js/pdf.js')
    return makePDF(bytes, { css: '', params: {}, worker: () => fake.webWorker, ...opts })
  }

  it('theBytes_GoToPdfjsOnce_AsData_WithTheHostsWorker', async () => {
    fakePdfjs(fake)
    const bytes = new Uint8Array([37, 80, 68, 70])
    await makePDF(bytes, {})
    expect(fake.params!.data).toBe(bytes)
    expect(fake.params!.range).toBeUndefined()
    expect((fake.params!.worker as { opts: unknown }).opts).toEqual({ port: fake.webWorker })
  })

  /** The worker says something (any message: an answer, a page's operator chunk), as pdf.js's port would hear it. */
  const speaks = () => fake.webWorker.addEventListener.mock.calls.filter(([t]) => t === 'message').forEach(([, f]) => f())

  it('aParseThatNeverAnswers_GoesSilent_AndIsTerminatedAfterTheSilence', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake, { load: never() })
    const open = makePDF(new Uint8Array(4), { silence: 5000 })
    const failed = expect(open).rejects.toThrow('this PDF took too long to read')
    await vi.advanceTimersByTimeAsync(4999)
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  })

  it('aBusyWorkerThatKeepsTalking_IsKept_LongPastTheSilence_ThenSilentIsTerminated', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake, { load: never() })
    const open = makePDF(new Uint8Array(4), { silence: 5000 })
    open.catch(() => {})
    // A long parse that keeps sending (operator chunks, images): 60 s with a word every 4 s.
    for (let t = 0; t < 15; t++) {
      await vi.advanceTimersByTimeAsync(4000)
      speaks()
    }
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
    // Then nothing at all.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  })

  it('callsQueuedBehindASlowOne_AreNotChargedForTheirWait', async () => {
    vi.useFakeTimers()
    // pdf.js's worker answers one call at a time: each page 4 s after the one before.
    let free = 0
    const queued = (i: number) => { free += 4000; const at = free; return new Promise((done) => setTimeout(() => done(page(i)), at)) }
    fakePdfjs(fake, { getPage: queued })
    const book = await makePDF(new Uint8Array(4), { silence: 5000 })
    const loads = [0, 1, 2, 3, 4].map((i) => book.sections[i].load())
    await vi.advanceTimersByTimeAsync(20_000)
    for (const l of loads) await expect(l).resolves.toMatchObject({ src: expect.stringMatching(/^blob:/) })
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
  })

  it('aRenderThatNeverAnswers_KillsTheBook_EveryLaterCallFailsAtOnce', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake, { getPage: never })
    const book = await makePDF(new Uint8Array(4), { silence: 5000 })
    const first = expect(book.sections[0].load()).rejects.toThrow('took too long')
    await vi.advanceTimersByTimeAsync(5000)
    await first
    expect(fake.webWorker.terminate).toHaveBeenCalledTimes(1)
    // No second wait: the worker is gone.
    await expect(book.sections[1].load()).rejects.toThrow('took too long')
    await expect(book.getTOC()).rejects.toThrow('took too long')
  })

  /** A page document as foliate's frame holds it (`attached`: its frame is still in the document). */
  const frameDoc = (attached = true) => ({ defaultView: attached ? {} : null, documentElement: { style: { setProperty() {} } }, querySelector: () => ({ replaceChildren() {}, replaceWith() {} }), adoptNode: (n: unknown) => n })
  const withDom = async (run: () => Promise<void>) => {
    ;(globalThis as any).document = { createElement: () => ({ getContext: () => ({}) }), querySelectorAll: () => [] }
    ;(globalThis as any).devicePixelRatio = 1
    try { await run() } finally {
      delete (globalThis as any).document
      delete (globalThis as any).devicePixelRatio
    }
  }

  it('aWorkerTerminatedAfterTheBookIsMade_IsReportedOnce_ItsRendersFailQuietly', () => withDom(async () => {
    vi.useFakeTimers()
    const onFail = vi.fn()
    fakePdfjs(fake, { getPage: (i: number) => Promise.resolve({ ...page(i), render: () => ({ promise: never() }) }) })
    const book = await makePDF(new Uint8Array(4), { silence: 5000, onFail })
    const { onZoom } = await book.sections[0].load()
    const rendering = onZoom({ doc: frameDoc(), scale: 1 })
    await vi.advanceTimersByTimeAsync(5000)
    // The render the dead worker never answers resolves quietly (no unhandled rejection): onFail says it, once.
    await expect(rendering).resolves.toBeUndefined()
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail.mock.calls[0][0].message).toBe('this PDF took too long to read')
    await expect(book.sections[1].load()).rejects.toThrow('took too long')
    expect(onFail).toHaveBeenCalledTimes(1)
  }))

  it('aRenderOfAPageTurnedAway_IsCancelledWhenTheNextStarts_QuietlyAndTheWorkerKept', () => withDom(async () => {
    const tasks: { cancel: ReturnType<typeof vi.fn>; promise: Promise<void> }[] = []
    const renderer = () => {
      let reject!: (e: unknown) => void
      const promise = new Promise<void>((_, no) => { reject = no })
      const task = { promise, cancel: vi.fn(() => reject(Object.assign(new Error('Rendering cancelled'), { name: 'RenderingCancelledException' }))) }
      tasks.push(task)
      return task
    }
    fakePdfjs(fake, { getPage: (i: number) => Promise.resolve({ ...page(i), render: renderer }) })
    const book = await makePDF(new Uint8Array(4), { silence: 5000 })
    const [a, b] = [await book.sections[0].load(), await book.sections[1].load()]
    const left = frameDoc()
    const first = a.onZoom({ doc: left, scale: 1 })
    // Page 1's frame leaves the document (a turn), page 2's starts drawing.
    left.defaultView = null
    void b.onZoom({ doc: frameDoc(), scale: 1 })
    expect(tasks[0].cancel).toHaveBeenCalled()
    expect(tasks[1].cancel).not.toHaveBeenCalled()
    await expect(first).resolves.toBeUndefined()
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
  }))

  it('aPageThatFailsToDraw_ARealError_IsTheBookStopped_ReportedOnce_NeverABlankNobodyHears', () => withDom(async () => {
    const onFail = vi.fn()
    // As pdf.js answers a page past the worker's memory: the drawing (errors ignored) resolves, its text rejects.
    const oom = Object.assign(new Error('Array buffer allocation failed'), { name: 'UnknownErrorException' })
    fakePdfjs(fake, { getPage: (i: number) => Promise.resolve({ ...page(i), render: () => ({ promise: Promise.reject(oom) }) }) })
    const book = await makePDF(new Uint8Array(4), { silence: 60_000, onFail })
    const { onZoom } = await book.sections[0].load()
    await expect(onZoom({ doc: frameDoc(), scale: 1 })).resolves.toBeUndefined()
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail.mock.calls[0][0].message).toBe('this page could not be drawn: Array buffer allocation failed')
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  }))

  it('aWorkerThatDiesAfterTheLoad_IsTheBookStopped_AtOnce', async () => {
    const onFail = vi.fn()
    fakePdfjs(fake)
    await makePDF(new Uint8Array(4), { silence: 60_000, onFail })
    for (const [type, f] of fake.webWorker.addEventListener.mock.calls) if (type === 'messageerror') f()
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail.mock.calls[0][0].message).toBe('the PDF reader stopped')
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  })

  it('answersInTime_NothingIsTerminated_EvenLongAfter', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake)
    const book = await makePDF(new Uint8Array(4), { silence: 5000 })
    await book.sections[0].load()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
  })

  it('aWorkerThatCannotStart_FailsTheOpenAtOnce', async () => {
    fakePdfjs(fake, { load: never() })
    const open = makePDF(new Uint8Array(4), { silence: 60_000 })
    await vi.waitFor(() => expect(fake.webWorker.addEventListener).toHaveBeenCalledWith('error', expect.any(Function)))
    fake.webWorker.addEventListener.mock.calls.find(([t]) => t === 'error')[1]()
    await expect(open).rejects.toThrow('could not start')
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  })

  it('theOutline_IsReadOnlyWhenAskedFor_AfterTheBookIsMade', async () => {
    const getOutline = vi.fn(() => Promise.resolve([{ title: 'One', dest: [{ num: 1 }], items: [] }]))
    fakePdfjs(fake, { getOutline })
    const book = await makePDF(new Uint8Array(4), {})
    expect(getOutline).not.toHaveBeenCalled()
    expect(book.toc).toBeUndefined()
    expect(await book.getTOC()).toEqual([{ label: 'One', href: '[{"num":1}]', subitems: null }])
    expect(book.toc).toHaveLength(1)
    await book.getTOC()
    expect(getOutline).toHaveBeenCalledTimes(1)
  })

  it('aJumpPastFourPages_WhileAFrameStillLoads_DoesNotRevokeItsUrl_ItsFrameLoadingDoes', async () => {
    fakePdfjs(fake)
    const book = await makePDF(new Uint8Array(4), {})
    // One after another, as a reader jumps: each load is done before the next one evicts.
    const loads = []
    for (const i of [0, 1, 2, 3, 4, 5]) loads.push(await book.sections[i].load())
    // Pages 0 and 1 left the four kept: pdf.js's page is cleaned up, its document's URL kept (its frame never loaded).
    expect(revoked).toEqual([])
    // Page 0's frame loads (foliate's first onZoom on it): now its URL goes, once.
    loads[0].onZoom({ doc: {}, scale: 1 })?.catch?.(() => {})
    loads[0].onZoom({ doc: {}, scale: 1 })?.catch?.(() => {})
    expect(revoked).toEqual([loads[0].src])
    // The rest, never loaded by a frame, go with the book.
    void book.destroy()
    expect(revoked.sort()).toEqual(loads.map((l: { src: string }) => l.src).sort())
  })

  it('aRevisitedPage_GetsADocumentOfItsOwn', async () => {
    fakePdfjs(fake)
    const book = await makePDF(new Uint8Array(4), {})
    const a = await book.sections[0].load()
    a.onZoom({ doc: {}, scale: 1 })?.catch?.(() => {})
    const b = await book.sections[0].load()
    expect(b.src).not.toBe(a.src)
    expect(revoked).toEqual([a.src])
  })
})
