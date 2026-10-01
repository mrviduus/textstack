import { describe, it, expect } from 'vitest'
import {
  buildChapterDiscussBrief, chooseChat, connectedAssistants, currentReviewChapter, nextChapterAfter, parseAssistant,
  resolveReviewHighlights, reviewsBySlug,
} from './chapterReview'
import { MAX_BRIEF_CHARS } from './assistantHandoff'

describe('currentReviewChapter', () => {
  const chapters = [
    { slug: 'contents', title: 'Contents' },
    { slug: 'prompts', title: '5. Prompt Engineering', wordCount: 5000 },
    { slug: 'short', title: 'Interlude', wordCount: 100 },
    { slug: null, title: 'Legacy' },
  ]
  const none = new Set<string>()
  it('no progress / unknown slug → null', () => {
    expect(currentReviewChapter(chapters, null, none)).toBeNull()
    expect(currentReviewChapter(chapters, 'gone', none)).toBeNull()
  })
  it('not reviewable (front matter, too short) → null, unless it already has a review', () => {
    expect(currentReviewChapter(chapters, 'contents', none)).toBeNull()
    expect(currentReviewChapter(chapters, 'short', none)).toBeNull()
    expect(currentReviewChapter(chapters, 'short', new Set(['short']))?.reviewed).toBe(true)
  })
  it('the current chapter, reviewed or not', () => {
    expect(currentReviewChapter(chapters, 'prompts', none)).toEqual({ slug: 'prompts', title: '5. Prompt Engineering', reviewed: false })
    expect(currentReviewChapter(chapters, 'prompts', new Set(['prompts']))?.reviewed).toBe(true)
  })
})

const upload = {
  title: 'AI Engineering', author: 'Chip Huyen',
  bookId: '77777777-7777-7777-7777-777777777777',
  chapterSlug: 'prompt-engineering', chapterTitle: 'Prompt Engineering',
}

describe('buildChapterDiscussBrief', () => {
  it('is one human sentence plus the id line', () => {
    expect(buildChapterDiscussBrief(upload)).toBe(
      'I\'m reading "AI Engineering" by Chip Huyen in TextStack, at the chapter "Prompt Engineering". Let\'s talk about it.\n\n' +
      `(TextStack: book ${upload.bookId}, chapter prompt-engineering)`)
  })

  it('names no tools and does not mention the connector — the method is in the server instructions', () => {
    const b = buildChapterDiscussBrief(upload)
    for (const t of ['get_chapter_review', 'save_chapter_review', 'connector', 'bookId', 'chapterSlug']) {
      expect(b).not.toContain(t)
    }
  })

  it('keys a catalog book by slug and edition', () => {
    const b = buildChapterDiscussBrief({ title: 'Dracula', editionId: 'e1', slug: 'dracula', chapterSlug: 'ch-1', chapterTitle: 'I' })
    expect(b).toContain('(TextStack: catalog dracula, edition e1, chapter ch-1)')
    expect(b).not.toContain('book ')
  })

  it('stays within the URL budget and keeps the ids when titles are huge', () => {
    const b = buildChapterDiscussBrief({ ...upload, title: 'T'.repeat(5000), author: 'A'.repeat(5000), chapterTitle: 'C'.repeat(5000) })
    expect(b.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(b).toContain(`(TextStack: book ${upload.bookId}, chapter prompt-engineering)`)
  })
})

describe('chooseChat', () => {
  const claude = { clientName: 'Claude' }
  const chatgpt = { clientName: 'ChatGPT' }

  it('nothing connected → none', () => expect(chooseChat([], 'claude')).toEqual({ kind: 'none' }))
  it('one connected → open it, whatever is remembered', () => {
    expect(chooseChat([chatgpt], 'claude')).toEqual({ kind: 'open', assistant: 'chatgpt' })
  })
  it('both, nothing remembered → pick', () => expect(chooseChat([claude, chatgpt], null)).toEqual({ kind: 'pick' }))
  it('both, remembered → open the remembered one', () => {
    expect(chooseChat([claude, chatgpt], 'chatgpt')).toEqual({ kind: 'open', assistant: 'chatgpt' })
  })
  it('unknown clients count as nothing', () => expect(chooseChat([{ clientName: 'Cursor' }], null)).toEqual({ kind: 'none' }))
  it('connectedAssistants dedupes two Claude grants', () => {
    expect(connectedAssistants([claude, { clientName: 'Claude Desktop' }])).toEqual(['claude'])
  })
  it('parseAssistant rejects junk', () => {
    expect(parseAssistant('claude')).toBe('claude')
    expect(parseAssistant('gemini')).toBeNull()
    expect(parseAssistant(null)).toBeNull()
  })
})

describe('review helpers', () => {
  it('reviewsBySlug keeps only chapter rows with a review', () => {
    const review = { methodVersion: 1, recall: null, blocks: [], applications: [], openThreads: [], closedThreadIds: [] }
    const map = reviewsBySlug([
      { chapterSlug: 'a', review },
      { chapterSlug: 'b', review: null },
      { chapterSlug: null, review },
    ])
    expect([...map.keys()]).toEqual(['a'])
  })

  it('nextChapterAfter follows list order and skips slugless chapters', () => {
    const chapters = [{ slug: 'a' }, { slug: null }, { slug: 'c' }]
    expect(nextChapterAfter(chapters, 'a')).toEqual({ slug: 'c' })
    expect(nextChapterAfter(chapters, 'c')).toBeNull()
    expect(nextChapterAfter(chapters, 'zzz')).toBeNull()
  })

  it('resolveReviewHighlights marks a deleted highlight, case-insensitively on the id', () => {
    expect(resolveReviewHighlights(['AB', 'gone'], [{ id: 'ab', selectedText: 'quote' }])).toEqual([
      { id: 'AB', text: 'quote' }, { id: 'gone', text: null },
    ])
  })
})
