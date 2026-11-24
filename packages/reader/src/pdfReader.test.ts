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

  it('aParseThatNeverAnswers_FailsAtTheDeadline_AndItsWorkerIsTerminated', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake, { load: never() })
    const open = makePDF(new Uint8Array(4), { deadline: 5000 })
    const failed = expect(open).rejects.toThrow('this PDF took too long to read')
    await vi.advanceTimersByTimeAsync(4999)
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(fake.webWorker.terminate).toHaveBeenCalled()
  })

  it('aRenderThatNeverAnswers_KillsTheBook_EveryLaterCallFailsAtOnce', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake, { getPage: never })
    const book = await makePDF(new Uint8Array(4), { deadline: 5000 })
    const first = expect(book.sections[0].load()).rejects.toThrow('took too long')
    await vi.advanceTimersByTimeAsync(5000)
    await first
    expect(fake.webWorker.terminate).toHaveBeenCalledTimes(1)
    // No second wait: the worker is gone.
    await expect(book.sections[1].load()).rejects.toThrow('took too long')
    await expect(book.getTOC()).rejects.toThrow('took too long')
  })

  it('aHeavyPage_GetsThePageBudget_NotTheOpensDeadline', async () => {
    vi.useFakeTimers()
    const slow = (i: number) => new Promise((done) => setTimeout(() => done(page(i)), 20_000))
    fakePdfjs(fake, { getPage: slow })
    const book = await makePDF(new Uint8Array(4), { deadline: 5000, pageDeadline: 60_000 })
    const loaded = book.sections[0].load()
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(loaded).resolves.toMatchObject({ src: expect.stringMatching(/^blob:/) })
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
  })

  it('aWorkerTerminatedAfterTheBookIsMade_IsReportedOnce_ItsRendersFailQuietly', async () => {
    vi.useFakeTimers()
    const onFail = vi.fn()
    let renders = 0
    const drawn = (i: number) => ({ ...page(i), render: () => ({ promise: (renders++ ? never() : Promise.resolve()) }) })
    fakePdfjs(fake, { getPage: (i: number) => Promise.resolve(drawn(i)) })
    ;(globalThis as any).document = { createElement: () => ({ getContext: () => ({}) }), querySelectorAll: () => [] }
    ;(globalThis as any).devicePixelRatio = 1
    try {
      const book = await makePDF(new Uint8Array(4), { deadline: 5000, pageDeadline: 60_000, onFail })
      const { onZoom } = await book.sections[0].load()
      const frame = { documentElement: { style: { setProperty() {} } }, querySelector: () => ({ replaceChildren() {}, replaceWith() {} }), adoptNode: (n: unknown) => n }
      renders = 1
      const rendering = onZoom({ doc: frame, scale: 1 })
      await vi.advanceTimersByTimeAsync(60_000)
      // The render the dead worker never answers resolves quietly (no unhandled rejection): onFail says it, once.
      await expect(rendering).resolves.toBeUndefined()
      expect(onFail).toHaveBeenCalledTimes(1)
      expect(onFail.mock.calls[0][0].message).toBe('this PDF took too long to read')
      await expect(book.sections[1].load()).rejects.toThrow('took too long')
      expect(onFail).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as any).document
      delete (globalThis as any).devicePixelRatio
    }
  })

  it('answersInTime_NothingIsTerminated_EvenLongAfter', async () => {
    vi.useFakeTimers()
    fakePdfjs(fake)
    const book = await makePDF(new Uint8Array(4), { deadline: 5000 })
    await book.sections[0].load()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.webWorker.terminate).not.toHaveBeenCalled()
  })

  it('aWorkerThatCannotStart_FailsTheOpenAtOnce', async () => {
    fakePdfjs(fake, { load: never() })
    const open = makePDF(new Uint8Array(4), { deadline: 60_000 })
    await vi.waitFor(() => expect(fake.webWorker.addEventListener).toHaveBeenCalledWith('error', expect.any(Function)))
    fake.webWorker.addEventListener.mock.calls[0][1]()
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
