/**
 * "Review chapter" — the pure half of the button and the summary page, shared by web and mobile.
 * Spec: docs/05-features/chapter-review.md §12. The review itself runs in the reader's own Claude or
 * ChatGPT over MCP (get_chapter_review → save_chapter_review); we only open the chat and show what
 * came back.
 */
import { MAX_BRIEF_CHARS, clipText as clip, textStackIdLine, type Assistant } from './assistantHandoff'
import type { ChapterReviewDto } from '../types/api'
import { isReviewableChapter } from './chapterReviewUi'

export interface ChapterReviewBriefInput {
  title: string
  author?: string | null
  /** UserBook id (an upload). Exactly one of bookId / editionId. */
  bookId?: string
  /** Edition id (a catalog book). */
  editionId?: string
  /** Catalog slug — read tools (get_chapter) take it, insight tools the editionId. */
  slug?: string
  chapterSlug: string
  chapterTitle: string
}

/**
 * The opening message for discussing a chapter — the one entry point (talk freely, then the
 * assistant offers the review). ≤ MAX_BRIEF_CHARS. A human sentence plus the id line; the behaviour
 * (soft spoilers, offering get_chapter_review → save_chapter_review) is in the MCP server
 * instructions. Titles are clipped so the id line survives the cap whatever the book is called.
 */
export function buildChapterDiscussBrief(input: ChapterReviewBriefInput): string {
  const author = input.author ? ` by ${clip(input.author, 120)}` : ''
  const id = textStackIdLine({ bookId: input.bookId, editionId: input.editionId, slug: input.slug, chapterSlug: input.chapterSlug })
  const brief = [
    `I'm reading "${clip(input.title, 200)}"${author} in TextStack, at the chapter "${clip(input.chapterTitle, 200)}". Let's talk about it.`,
    ...(id ? ['', id] : []),
  ].join('\n')
  return brief.length <= MAX_BRIEF_CHARS ? brief : brief.slice(0, MAX_BRIEF_CHARS).trimEnd()
}

/** Which assistants the reader connected over OAuth (`GET /me/oauth/grants` → clientName). */
export function connectedAssistants(grants: readonly { clientName: string }[]): Assistant[] {
  const names = grants.map(g => g.clientName.toLowerCase())
  const out: Assistant[] = []
  if (names.some(n => n.includes('claude'))) out.push('claude')
  if (names.some(n => n.includes('chatgpt') || n.includes('openai'))) out.push('chatgpt')
  return out
}

export type ChatChoice =
  | { kind: 'none' }                          // nothing connected → connect dialog, never a dead chat
  | { kind: 'open'; assistant: Assistant }    // exactly one, or the remembered one of two
  | { kind: 'pick' }                          // both, nothing remembered → small menu

/**
 * What the Review button does. A remembered choice counts only while that assistant is still
 * connected — a revoked grant must not keep opening a chat that cannot reach TextStack.
 */
export function chooseChat(grants: readonly { clientName: string }[], remembered: Assistant | null): ChatChoice {
  const connected = connectedAssistants(grants)
  if (connected.length === 0) return { kind: 'none' }
  if (connected.length === 1) return { kind: 'open', assistant: connected[0] }
  if (remembered && connected.includes(remembered)) return { kind: 'open', assistant: remembered }
  return { kind: 'pick' }
}

/** A stored preference back into a value, tolerating anything the storage hands us. */
export function parseAssistant(value: unknown): Assistant | null {
  return value === 'claude' || value === 'chatgpt' ? value : null
}

/** Storage key for the remembered choice (localStorage on web, AsyncStorage on mobile). */
export const REVIEW_ASSISTANT_KEY = 'chapterReview.assistant'

/** Reviewed chapters by slug, from the book's insights (`GET /me/insights`). */
export function reviewsBySlug<T extends { chapterSlug: string | null; review?: ChapterReviewDto | null }>(
  insights: readonly T[],
): Map<string, T & { review: ChapterReviewDto }> {
  const map = new Map<string, T & { review: ChapterReviewDto }>()
  for (const i of insights) {
    if (i.chapterSlug && i.review) map.set(i.chapterSlug, i as T & { review: ChapterReviewDto })
  }
  return map
}

/** The chapter after `slug` in list (reading) order, or null at the end / unknown slug. */
export function nextChapterAfter<C extends { slug: string | null }>(chapters: readonly C[], slug: string): C | null {
  const i = chapters.findIndex(c => c.slug === slug)
  if (i < 0) return null
  return chapters.slice(i + 1).find(c => !!c.slug) ?? null
}

/** A block's highlight ids against the reader's highlights; a deleted one resolves to `text: null`. */
export function resolveReviewHighlights(
  ids: readonly string[],
  highlights: readonly { id: string; selectedText: string }[],
): { id: string; text: string | null }[] {
  const byId = new Map(highlights.map(h => [h.id.toLowerCase(), h.selectedText]))
  return ids.map(id => ({ id, text: byId.get(id.toLowerCase()) ?? null }))
}

/**
 * The "Review current chapter" item of the book page's Assistant menu: the chapter the reader's
 * progress points at, and whether it already has a review (→ "Open review" instead). Null — item
 * hidden — with no progress, a slugless chapter (reviews are keyed by slug), or a chapter the rows
 * would not offer Review on (`isReviewableChapter`) unless it already has a review — same rule as
 * the chapter rows.
 */
export function currentReviewChapter<C extends { slug?: string | null; title: string; wordCount?: number | null }>(
  chapters: readonly C[],
  currentSlug: string | null | undefined,
  reviewed: { has(slug: string): boolean },
): { slug: string; title: string; reviewed: boolean } | null {
  if (!currentSlug) return null
  const ch = chapters.find(c => c.slug === currentSlug)
  if (!ch?.slug) return null
  const done = reviewed.has(ch.slug)
  if (!done && !isReviewableChapter(ch)) return null
  return { slug: ch.slug, title: ch.title, reviewed: done }
}
