import type { BookDetail, ChapterSummary } from '../types/api'
import { parseSeoThemes } from '@textstack/shared'

export interface FAQItem {
  question: string
  answer: string
}

// Common English stopwords to filter out
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'shall', 'can', 'need', 'dare', 'ought', 'used', 'it', 'its', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'what', 'which', 'who',
  'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'also', 'now', 'here', 'there', 'then',
  'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'again', 'further', 'once', 'his', 'her', 'him', 'their',
  'our', 'my', 'your', 'one', 'man', 'him', 'himself', 'herself', 'itself', 'up',
  'down', 'out', 'off', 'over', 'any', 'if', 'because', 'until', 'while', 'being',
])

/**
 * Extract theme keywords from description (word frequency, filter stopwords)
 */
export function extractThemes(description: string | null, count = 4): string[] {
  if (!description) return []

  const words = description
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))

  const freq = new Map<string, number>()
  for (const word of words) {
    freq.set(word, (freq.get(word) || 0) + 1)
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1))
}

/**
 * Reading time estimate (250 wpm avg)
 */
export function estimateReadingTime(chapters: ChapterSummary[], t: (key: string) => string): string {
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0)
  if (totalWords === 0) return t('bookDetail.readingTimeUnknown')

  const minutes = Math.round(totalWords / 250)
  if (minutes < 60) return t('bookDetail.readingTimeMinutes').replace('{minutes}', String(minutes))

  const hours = Math.round(minutes / 60)
  return hours === 1
    ? t('bookDetail.readingTimeHour')
    : t('bookDetail.readingTimeHours').replace('{hours}', String(hours))
}

/**
 * Get year from ISO date
 */
export function extractYear(publishedAt: string | null): number | null {
  if (!publishedAt) return null
  const year = new Date(publishedAt).getFullYear()
  return isNaN(year) ? null : year
}

/**
 * Generate FAQ items from book metadata
 */
export function generateFAQs(book: BookDetail, t: (key: string) => string): FAQItem[] {
  const faqs: FAQItem[] = []
  const authorName = book.authors[0]?.name || t('books.unknown')
  const year = extractYear(book.publishedAt)
  const readingTime = estimateReadingTime(book.chapters, t)

  faqs.push({
    question: t('bookDetail.faqWhoWrote').replace('{title}', book.title),
    answer: t('bookDetail.faqWhoWroteAnswer').replace('{title}', book.title).replace('{author}', authorName),
  })

  faqs.push({
    question: t('bookDetail.faqChapters').replace('{title}', book.title),
    answer: t('bookDetail.faqChaptersAnswer').replace('{title}', book.title).replace('{count}', String(book.chapters.length)),
  })

  faqs.push({
    question: t('bookDetail.faqReadingTime').replace('{title}', book.title),
    answer: t('bookDetail.faqReadingTimeAnswer').replace('{title}', book.title).replace('{time}', readingTime),
  })

  if (year) {
    faqs.push({
      question: t('bookDetail.faqPublished').replace('{title}', book.title),
      answer: t('bookDetail.faqPublishedAnswer').replace('{title}', book.title).replace('{year}', String(year)),
    })
  }

  faqs.push({
    question: t('bookDetail.faqFree').replace('{title}', book.title),
    answer: t('bookDetail.faqFreeAnswer').replace('{title}', book.title),
  })

  faqs.push({
    question: t('bookDetail.faqLanguages').replace('{title}', book.title),
    answer:
      book.otherEditions.length > 0
        ? t('bookDetail.faqLanguagesYes').replace('{title}', book.title).replace('{count}', String(book.otherEditions.length + 1))
        : t('bookDetail.faqLanguagesNo').replace('{title}', book.title).replace('{lang}', book.language.toUpperCase()),
  })

  return faqs
}

/**
 * Generate "About" section text from description or template
 */
export function generateAboutText(book: BookDetail, t: (key: string) => string): string {
  if (book.description) {
    return book.description.replace(/<[^>]*>/g, '')
  }

  const authorName = book.authors[0]?.name || t('books.unknown')
  return t('bookDetail.aboutFallback').replace('{title}', book.title).replace('{author}', authorName)
}

/**
 * Generate "Why relevant" section text
 * Uses custom seoRelevanceText if set, otherwise auto-generates
 */
export function generateRelevanceText(book: BookDetail, t: (key: string) => string): string {
  // Use custom if set
  if (book.seoRelevanceText) {
    return book.seoRelevanceText
  }

  const authorName = book.authors[0]?.name || t('books.unknown')
  const themes = extractThemes(book.description, 2)
  const themeText = themes.length > 0 ? themes.join(' and ').toLowerCase() : 'universal human experiences'

  return t('bookDetail.relevanceText')
    .replace('{title}', book.title)
    .replace('{author}', authorName)
    .replace('{themes}', themeText)
}

/**
 * Get themes from custom JSON or auto-extract from description
 */
export function getThemes(book: BookDetail, count = 4): string[] {
  if (book.seoThemesJson) {
    const themes = parseSeoThemes(book.seoThemesJson)
    if (themes.length > 0) return themes.slice(0, count)
  }
  return extractThemes(book.description, count)
}

/**
 * Get FAQs from custom JSON or auto-generate
 */
export function getFAQs(book: BookDetail, t: (key: string) => string): FAQItem[] {
  // Use custom if set
  if (book.seoFaqsJson) {
    try {
      const faqs = JSON.parse(book.seoFaqsJson)
      if (Array.isArray(faqs)) {
        return faqs.map((f: { q?: string; question?: string; a?: string; answer?: string }) => ({
          question: f.q || f.question || '',
          answer: f.a || f.answer || '',
        })).filter((f: FAQItem) => f.question && f.answer)
      }
    } catch {
      // Fall through to auto-generate
    }
  }
  return generateFAQs(book, t)
}

/**
 * Generate theme description
 */
export function generateThemeDescription(theme: string, title: string): string {
  const themeDescriptions: Record<string, string> = {
    love: 'Explores the complexities of romantic and familial love',
    death: 'Confronts mortality and its impact on the human experience',
    justice: 'Examines moral righteousness and the pursuit of fairness',
    guilt: 'Delves into the psychological burden of wrongdoing',
    redemption: 'Charts the path from moral failure to spiritual renewal',
    suffering: 'Depicts hardship and its transformative power',
    isolation: 'Explores loneliness and the need for human connection',
    identity: 'Questions the nature of self and personal authenticity',
    power: 'Investigates authority, control, and their corruption',
    freedom: 'Celebrates liberty and the struggle against oppression',
    society: 'Critiques social structures and conventions',
    faith: 'Explores religious belief and spiritual searching',
    morality: 'Examines ethical dilemmas and moral choices',
    nature: 'Depicts the relationship between humans and the natural world',
  }

  const lowerTheme = theme.toLowerCase()
  if (themeDescriptions[lowerTheme]) {
    return `${themeDescriptions[lowerTheme]} in ${title}.`
  }

  // Deterministic fallback templates (pick based on hash)
  const templates = [
    `The theme of ${lowerTheme} weaves through ${title}, adding depth to its narrative.`,
    `${theme} emerges as a defining element in ${title}, shaping character development.`,
    `In ${title}, ${lowerTheme} provides a lens for understanding the story's core message.`,
    `${title} thoughtfully explores ${lowerTheme} through its central conflicts.`,
    `The presence of ${lowerTheme} in ${title} connects readers to its enduring relevance.`,
  ]

  const hash = (theme + title).split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return templates[hash % templates.length]
}
