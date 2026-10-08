import { describe, it, expect, vi } from 'vitest'
import { resolveResumeRoute, resumeSlugFor, editionListPick, type ResumeDeps } from './resumeTarget'

const textPos = (chapterSlug: string) =>
  JSON.stringify({ v: 1, chapterSlug, anchor: { prefix: '', exact: 'x', suffix: '' } })

const chapters = [{ slug: 'ch-1', chapterNumber: 0 }, { slug: 'ch-2', chapterNumber: 1 }, { slug: 'ch-5', chapterNumber: 4 }]

function deps(o: Partial<ResumeDeps> = {}): ResumeDeps {
  return {
    getEdition: vi.fn(async () => ({ id: 'ed-1', chapters })),
    getEditionProgress: vi.fn(async () => null),
    getUserBook: vi.fn(async () => ({ chapters: [{ slug: 'part-1', chapterNumber: 2, sourceStartPage: 1 }, { slug: 'part-2', chapterNumber: 3, sourceStartPage: 10 }] })),
    getUserBookProgress: vi.fn(async () => null),
    ...o,
  }
}

describe('resumeSlugFor — the saved place, by chapter', () => {
  it('reads the chapter from a text position (ADR-015) when the row carries no slug', () => {
    expect(resumeSlugFor({ chapterSlug: null, locator: null, positionJson: textPos('ch-5') }, chapters)).toBe('ch-5')
  })

  it('prefers the text position over a lagging chapterSlug projection', () => {
    expect(resumeSlugFor({ chapterSlug: 'ch-2', locator: null, positionJson: textPos('ch-5') }, chapters)).toBe('ch-5')
  })

  it('a text position naming a chapter no longer in the list never drops a valid chapterSlug (review 2 #2)', () => {
    expect(resumeSlugFor({ chapterSlug: 'ch-2', locator: null, positionJson: textPos('gone') }, chapters)).toBe('ch-2')
  })

  it('…then falls to the page locator', () => {
    const pdf = [{ slug: 'part-1', chapterNumber: 0, sourceStartPage: 1 }, { slug: 'part-2', chapterNumber: 1, sourceStartPage: 10 }]
    expect(resumeSlugFor({ chapterSlug: null, locator: 'page:12', positionJson: textPos('gone') }, pdf)).toBe('part-2')
  })

  it('without a chapter list, the text position still names the chapter (Library rows)', () => {
    expect(resumeSlugFor({ chapterSlug: 'ch-2', locator: null, positionJson: textPos('ch-5') }, [])).toBe('ch-5')
    expect(resumeSlugFor({ chapterSlug: 'ch-2', locator: null, positionJson: null }, [])).toBe('ch-2')
  })
})

describe('resolveResumeRoute — one answer for the hero, the list and the detail screens', () => {
  it('a pick that already names its chapter opens it without asking the server', async () => {
    const d = deps()
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: 'ch-2' }, d)).toBe('/reader/dracula/ch-2')
    expect(d.getEdition).not.toHaveBeenCalled()
  })

  it('a catalog book saved 45% in by text position opens THAT chapter, never chapter 1 (review #1)', async () => {
    const d = deps({ getEditionProgress: vi.fn(async () => ({ chapterSlug: null, locator: '', positionJson: textPos('ch-5'), percent: 0.45 })) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, d)).toBe('/reader/dracula/ch-5')
  })

  it('a catalog book with a position nobody can place goes to the book screen, not chapter 1', async () => {
    const d = deps({ getEditionProgress: vi.fn(async () => ({ chapterSlug: null, locator: '', positionJson: null, percent: 0.45 })) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, d)).toBe('/book/dracula')
  })

  it('uses the editionId the caller has: book and progress fetched in parallel (review 2 #8)', async () => {
    let releaseBook!: () => void
    const getEdition = vi.fn(() => new Promise<{ id: string; chapters: typeof chapters }>(r => { releaseBook = () => r({ id: 'ed-1', chapters }) }))
    const getEditionProgress = vi.fn(async () => ({ chapterSlug: null, locator: '', positionJson: textPos('ch-5'), percent: 0.4 }))
    const p = resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null, editionId: 'ed-1' }, deps({ getEdition, getEditionProgress }))
    expect(getEditionProgress).toHaveBeenCalledWith('ed-1') // before the book answered
    releaseBook()
    expect(await p).toBe('/reader/dracula/ch-5')
  })

  it('a catalog book never opened starts at its first chapter', async () => {
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, deps())).toBe('/reader/dracula/ch-1')
  })

  it('a chapterless PDF upload opens the chapter holding its saved page', async () => {
    const d = deps({ getUserBookProgress: vi.fn(async () => ({ chapterSlug: null, locator: 'page:12', percent: 0.6 })) })
    expect(await resolveResumeRoute({ type: 'userbook', id: 'ub-1', chapterSlug: null }, d)).toBe('/my-books/read/ub-1/part-2')
  })

  it('offline or failing: the detail screen, as before', async () => {
    const d = deps({ getEdition: vi.fn(async () => { throw new Error('offline') }) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, d)).toBe('/book/dracula')
  })
})

const httpError = (status: number) => Object.assign(new Error(`API error: ${status}`), { status })

describe('review 4 — a failed progress read is not "no progress"', () => {
  it('catalog: 404 (never read) starts at chapter 1; a 5xx / timeout opens the book screen', async () => {
    const notFound = deps({ getEditionProgress: vi.fn(async () => { throw httpError(404) }) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, notFound)).toBe('/reader/dracula/ch-1')
    const down = deps({ getEditionProgress: vi.fn(async () => { throw httpError(503) }) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null }, down)).toBe('/book/dracula')
    const offline = deps({ getEditionProgress: vi.fn(async () => { throw new TypeError('Network request failed') }) })
    expect(await resolveResumeRoute({ type: 'edition', slug: 'dracula', chapterSlug: null, editionId: 'ed-1' }, offline)).toBe('/book/dracula')
  })

  it('uploads too', async () => {
    const notFound = deps({ getUserBookProgress: vi.fn(async () => { throw httpError(404) }) })
    expect(await resolveResumeRoute({ type: 'userbook', id: 'ub-1', chapterSlug: null }, notFound)).toBe('/my-books/read/ub-1/part-1')
    const down = deps({ getUserBookProgress: vi.fn(async () => { throw httpError(500) }) })
    expect(await resolveResumeRoute({ type: 'userbook', id: 'ub-1', chapterSlug: null }, down)).toBe('/my-books/ub-1')
  })
})

describe('review 4 — catalog chapters are matched by their real slugs (#7)', () => {
  const catalog = [{ slug: null, chapterNumber: 2 }, { slug: 'b', chapterNumber: 3 }]
  it('no synthetic chapter-N for a catalog book', () => {
    expect(resumeSlugFor({ chapterSlug: 'chapter-2', locator: null }, catalog)).toBeNull()
  })
  it('uploads keep the chapter-N key the reader route uses', () => {
    expect(resumeSlugFor({ chapterSlug: 'chapter-2', locator: null }, catalog, { synthesize: true })).toBe('chapter-2')
  })
})

describe('editionListPick — the Library list never pushes an unverified slug (#4)', () => {
  it('a slug the server derived opens directly', () => {
    expect(editionListPick('dracula', 'ed-1', { chapterSlug: 'ch-2', locator: 'scroll:ch-2:10', positionJson: null }).chapterSlug).toBe('ch-2')
  })
  it('a slug that only the text position names is left to the resolver (checked against the chapter list)', () => {
    const pick = editionListPick('dracula', 'ed-1', { chapterSlug: 'ch-2', locator: '', positionJson: textPos('ch-5') })
    expect(pick.chapterSlug).toBeNull()
    expect(pick.editionId).toBe('ed-1')
    expect(pick.place?.positionJson).toBe(textPos('ch-5'))
  })
})

