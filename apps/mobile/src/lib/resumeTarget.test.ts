import { describe, it, expect, vi } from 'vitest'
import { resolveResumeRoute, resumeSlugFor, type ResumeDeps } from './resumeTarget'

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
