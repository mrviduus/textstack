import { describe, it, expect } from 'vitest'
import {
  buildChapterReviewBrief, chooseChat, connectedAssistants, nextChapterAfter, parseAssistant,
  resolveReviewHighlights, reviewsBySlug,
} from './chapterReview'
import { MAX_BRIEF_CHARS } from './assistantHandoff'

const upload = {
  title: 'AI Engineering', author: 'Chip Huyen',
  bookId: '77777777-7777-7777-7777-777777777777',
  chapterSlug: 'prompt-engineering', chapterTitle: 'Prompt Engineering',
}

describe('buildChapterReviewBrief', () => {
  it('names book, author, chapter, the upload id, the slug and both tools', () => {
    const b = buildChapterReviewBrief(upload)
    for (const s of ['AI Engineering', 'Chip Huyen', 'Prompt Engineering', `bookId ${upload.bookId}`,
      'chapterSlug "prompt-engineering"', 'get_chapter_review', 'save_chapter_review', 'follow the method exactly']) {
      expect(b).toContain(s)
    }
    expect(b).not.toContain('editionId')
  })

  it('keys a catalog book by editionId', () => {
    const b = buildChapterReviewBrief({ title: 'Dracula', editionId: 'e1', chapterSlug: 'ch-1', chapterTitle: 'I' })
    expect(b).toContain('editionId e1')
    expect(b).not.toContain('bookId')
  })

  it('stays within the URL budget and keeps the ids when titles are huge', () => {
    const b = buildChapterReviewBrief({ ...upload, title: 'T'.repeat(5000), author: 'A'.repeat(5000), chapterTitle: 'C'.repeat(5000) })
    expect(b.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(b).toContain(upload.bookId)
    expect(b).toContain('save_chapter_review')
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
