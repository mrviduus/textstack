import { describe, it, expect } from 'vitest'
import { buildHandoffBrief, handoffUrl, MAX_BRIEF_CHARS } from './assistantHandoff'

/**
 * The handoff is a LINK, and a link has a length limit that nothing else in the
 * app has. These tests pin the two things that break silently: a brief that grows
 * past what a URL can carry, and an identifier that names the wrong id space.
 */
describe('buildHandoffBrief', () => {
  const book = {
    title: 'Designing Data-Intensive Applications',
    author: 'Martin Kleppmann',
    bookId: '77777777-7777-7777-7777-777777777777',
    progressFraction: 0.424,
    chapterTitle: 'Replication',
  }

  it('names the book, the author and where the reader stopped', () => {
    const brief = buildHandoffBrief(book)
    expect(brief).toContain('Designing Data-Intensive Applications')
    expect(brief).toContain('Martin Kleppmann')
    expect(brief).toContain('42%')
    expect(brief).toContain('Replication')
  })

  it('names an upload by bookId and points at the my-library tools', () => {
    const brief = buildHandoffBrief(book)
    expect(brief).toContain('bookId 77777777-7777-7777-7777-777777777777')
    expect(brief).toContain('get_my_book')
    // An upload has no editionId; offering one would send the assistant to a 404.
    expect(brief).not.toContain('editionId')
  })

  it('names a catalog book by editionId and points at the catalog tools', () => {
    const brief = buildHandoffBrief({
      title: 'Dracula',
      editionId: '33333333-3333-3333-3333-333333333333',
    })
    expect(brief).toContain('editionId 33333333-3333-3333-3333-333333333333')
    expect(brief).toContain('get_book')
    expect(brief).not.toContain('bookId')
  })

  it('asks the assistant to write conclusions back', () => {
    // Without this line the conversation happens and nothing comes home, which is
    // the entire failure mode the feature exists to fix.
    expect(buildHandoffBrief(book)).toContain('save_insight')
  })

  it('reads the fraction as a fraction — the defect this field is named after', () => {
    // Progress is stored as 0..1 everywhere in this codebase. Taking it as
    // "0-100" made Math.round(0.42) === 0, so a reader 42% into a book opened a
    // chat that said "about 0% in". It only shows when there IS progress, which
    // is why the first pass missed it.
    expect(buildHandoffBrief({ title: 'D', progressFraction: 0.424 })).toContain('42%')
    expect(buildHandoffBrief({ title: 'D', progressFraction: 0.07 })).toContain('7%')
    expect(buildHandoffBrief({ title: 'D', progressFraction: 1 })).toContain('100%')
  })

  it('says nothing rather than "about 0% in" when barely started or not started', () => {
    for (const f of [0, 0.001, null, undefined]) {
      expect(buildHandoffBrief({ title: 'Dracula', progressFraction: f })).not.toContain('%')
    }
  })

  it('caps the brief, because it has to survive being a URL', () => {
    const brief = buildHandoffBrief({
      title: 'T'.repeat(5000),
      author: 'A'.repeat(5000),
      bookId: '77777777-7777-7777-7777-777777777777',
    })
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
  })

  it('keeps the encoded URL inside the safe ~2000-character floor', () => {
    const url = handoffUrl('claude', buildHandoffBrief({
      title: 'T'.repeat(5000),
      bookId: '77777777-7777-7777-7777-777777777777',
    }))
    expect(url.length).toBeLessThanOrEqual(2000)
  })
})

describe('handoffUrl', () => {
  it('opens a NEW conversation on each service with the brief prefilled', () => {
    expect(handoffUrl('claude', 'hello there')).toBe('https://claude.ai/new?q=hello%20there')
    expect(handoffUrl('chatgpt', 'hello there')).toBe('https://chatgpt.com/?q=hello%20there')
  })

  it('encodes characters that would otherwise break the query', () => {
    const url = handoffUrl('claude', 'a & b "quoted" #1')
    expect(url).not.toContain(' ')
    expect(url).not.toContain('"')
    expect(url).toContain('%26')
    expect(url).toContain('%23')
  })
})
