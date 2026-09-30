import { describe, it, expect } from 'vitest'
import { buildHandoffBrief, handoffUrl, MAX_BRIEF_CHARS } from './assistantHandoff'

/**
 * The handoff is a LINK the reader sees prefilled. These tests pin what breaks silently: a brief
 * that grows past what a URL can carry, an id that goes missing, and internals (tool names,
 * "connector") leaking back into a message written for a person.
 */
const TOOL_NAMES = ['get_book', 'get_chapter', 'get_my_book', 'get_my_chapter', 'get_my_insights', 'save_insight', 'connector']

describe('buildHandoffBrief', () => {
  const book = {
    title: 'Designing Data-Intensive Applications',
    author: 'Martin Kleppmann',
    bookId: '77777777-7777-7777-7777-777777777777',
    progressFraction: 0.424,
    chapterTitle: 'Replication',
  }

  it('is one human sentence plus the id line for an upload', () => {
    expect(buildHandoffBrief(book)).toBe(
      'Let\'s discuss "Designing Data-Intensive Applications" by Martin Kleppmann in TextStack. ' +
      'I\'m about 42% in, at "Replication".\n\n' +
      '(TextStack: book 77777777-7777-7777-7777-777777777777)')
  })

  it('names no tools and does not mention the connector', () => {
    const briefs = [
      buildHandoffBrief(book),
      buildHandoffBrief({ title: 'Dracula', editionId: '33333333-3333-3333-3333-333333333333', slug: 'dracula' }),
    ]
    for (const b of briefs) for (const t of TOOL_NAMES) expect(b).not.toContain(t)
  })

  it('gives a catalog book BOTH slug and editionId — read tools take one, insight tools the other', () => {
    const brief = buildHandoffBrief({
      title: 'Dracula',
      editionId: '33333333-3333-3333-3333-333333333333',
      slug: 'dracula',
    })
    expect(brief).toContain('(TextStack: catalog dracula, edition 33333333-3333-3333-3333-333333333333)')
    expect(brief).not.toContain('book ')
  })

  it('an upload carries no edition', () => {
    expect(buildHandoffBrief(book)).not.toContain('edition')
  })

  it('omits the id line when there is no id', () => {
    expect(buildHandoffBrief({ title: 'Dracula' })).toBe('Let\'s discuss "Dracula" in TextStack.')
  })

  it('reads the fraction as a fraction — the defect this field is named after', () => {
    // Progress is stored as 0..1 everywhere in this codebase. Taking it as "0-100" made
    // Math.round(0.42) === 0, so a reader 42% in opened a chat that said "about 0% in".
    expect(buildHandoffBrief({ title: 'D', progressFraction: 0.424 })).toContain('42%')
    expect(buildHandoffBrief({ title: 'D', progressFraction: 0.07 })).toContain('7%')
    expect(buildHandoffBrief({ title: 'D', progressFraction: 1 })).toContain('100%')
  })

  it('says nothing rather than "about 0% in" when barely started or not started', () => {
    for (const f of [0, 0.001, null, undefined]) {
      expect(buildHandoffBrief({ title: 'Dracula', progressFraction: f })).not.toContain('%')
    }
  })

  it('caps the brief and keeps the id when every text field is huge', () => {
    const brief = buildHandoffBrief({
      title: 'T'.repeat(5000),
      author: 'A'.repeat(5000),
      chapterTitle: 'C'.repeat(5000),
      bookId: '77777777-7777-7777-7777-777777777777',
    })
    expect(brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(brief).toContain('(TextStack: book 77777777-7777-7777-7777-777777777777)')
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
