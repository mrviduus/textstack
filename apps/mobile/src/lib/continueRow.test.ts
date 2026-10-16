import { describe, it, expect } from 'vitest'
import type { ContinueReadingPick, LibraryEntry } from '@textstack/shared'
import { continuePickFor, firstContinuePick, keyOfPick } from './continueRow'

const upload = (id: string, over: Record<string, unknown> = {}) =>
  ({ kind: 'upload', book: { id, status: 'Ready', completedAt: null, ...over } }) as unknown as LibraryEntry
const saved = (slug: string) => ({ kind: 'saved', item: { slug, editionId: `e-${slug}` } }) as unknown as LibraryEntry
const userPick = (id: string): ContinueReadingPick => ({ type: 'userbook', id, title: id, coverPath: null, percent: 0.5, chapterSlug: 'c1', updatedAtMs: 1 })
const editionPick = (slug: string): ContinueReadingPick => ({ type: 'edition', slug, title: slug, coverPath: null, percent: 0.2, chapterSlug: 'c1', updatedAtMs: 1 })
const picksOf = (...ps: ContinueReadingPick[]) => new Map(ps.map(p => [keyOfPick(p), p]))

describe('continuePickFor', () => {
  it('upload and saved rows find their own pick; no pick → none', () => {
    const picks = picksOf(userPick('u1'), editionPick('dracula'))
    expect(continuePickFor(upload('u1'), picks)?.type).toBe('userbook')
    expect(continuePickFor(saved('dracula'), picks)?.type).toBe('edition')
    expect(continuePickFor(upload('u2'), picks)).toBeUndefined()
    // same id/slug, other kind, must not cross over
    expect(continuePickFor(saved('u1'), picks)).toBeUndefined()
  })

  it('an upload that is not ready, or is marked finished, offers no Continue', () => {
    const picks = picksOf(userPick('u1'))
    expect(continuePickFor(upload('u1', { status: 'Processing' }), picks)).toBeUndefined()
    expect(continuePickFor(upload('u1', { status: 'Failed' }), picks)).toBeUndefined()
    expect(continuePickFor(upload('u1', { completedAt: '2026-10-01' }), picks)).toBeUndefined()
    expect(continuePickFor(upload('u1', { status: 'completed' }), picks)).toBeDefined()
  })
})

describe('firstContinuePick', () => {
  it('is the first VISIBLE row with a Continue, not the global top', () => {
    const picks = picksOf(userPick('hidden'), userPick('u2'), editionPick('s1'))
    // `hidden` is filtered out of the visible list
    expect(firstContinuePick([saved('none'), upload('u2'), saved('s1')], picks)).toBe(picks.get('u:u2'))
    expect(firstContinuePick([saved('none')], picks)).toBeUndefined()
  })
})
