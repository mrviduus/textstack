import type { BookDetail, ChapterSummary } from '../types/api'

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
export function estimateReadingTime(chapters: ChapterSummary[]): string {
  const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount || 0), 0)
  if (totalWords === 0) return 'Unknown'

  const minutes = Math.round(totalWords / 250)
  if (minutes < 60) return `${minutes} minutes`

  const hours = Math.round(minutes / 60)
  return hours === 1 ? '1 hour' : `${hours} hours`
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
export function generateFAQs(book: BookDetail): FAQItem[] {
  const faqs: FAQItem[] = []
  const authorName = book.authors[0]?.name || 'Unknown'
  const year = extractYear(book.publishedAt)
  const readingTime = estimateReadingTime(book.chapters)

  faqs.push({
    question: `Who wrote ${book.title}?`,
    answer: `${book.title} was written by ${authorName}.`,
  })

  faqs.push({
    question: `How many chapters are in ${book.title}?`,
    answer: `${book.title} contains ${book.chapters.length} chapters.`,
  })

  faqs.push({
    question: `How long does it take to read ${book.title}?`,
    answer: `The estimated reading time for ${book.title} is ${readingTime}.`,
  })

  if (year) {
    faqs.push({
      question: `When was ${book.title} published?`,
      answer: `${book.title} was first published in ${year}.`,
    })
  }

  faqs.push({
    question: `Can I read ${book.title} for free?`,
    answer: `Yes, ${book.title} is available to read for free on TextStack.`,
  })

  faqs.push({
    question: `Is ${book.title} available in other languages?`,
    answer:
      book.otherEditions.length > 0
        ? `Yes, ${book.title} is available in ${book.otherEditions.length + 1} language(s) on TextStack.`
        : `Currently ${book.title} is only available in ${book.language.toUpperCase()} on TextStack.`,
  })

  return faqs
}

/**
 * Generate "About" section text from description or template
 * Uses custom seoAboutText if set, otherwise auto-generates
 */
export function generateAboutText(book: BookDetail): string {
  // Use custom if set
  if (book.seoAboutText) {
    return book.seoAboutText
  }

  if (book.description) {
    // Use first 2 sentences of description
    const sentences = book.description.replace(/<[^>]*>/g, '').split(/(?<=[.!?])\s+/)
    return sentences.slice(0, 2).join(' ')
  }

  const authorName = book.authors[0]?.name || 'an acclaimed author'
  return `${book.title} is a renowned work by ${authorName}. This literary classic continues to captivate readers with its compelling narrative and timeless themes.`
}

/**
 * Generate "Why relevant" section text
 * Uses custom seoRelevanceText if set, otherwise auto-generates
 */
export function generateRelevanceText(book: BookDetail): string {
  // Use custom if set
  if (book.seoRelevanceText) {
    return book.seoRelevanceText
  }

  const authorName = book.authors[0]?.name || 'the author'
  const themes = extractThemes(book.description, 2)
  const themeText = themes.length > 0 ? themes.join(' and ').toLowerCase() : 'universal human experiences'

  return `${book.title} by ${authorName} remains relevant today because it explores ${themeText} that transcend time and culture. Its insights into human nature continue to resonate with modern readers.`
}

/**
 * Get themes from custom JSON or auto-extract from description
 */
export function getThemes(book: BookDetail, count = 4): string[] {
  // Use custom if set
  if (book.seoThemesJson) {
    try {
      const themes = JSON.parse(book.seoThemesJson)
      if (Array.isArray(themes)) return themes.slice(0, count)
    } catch {
      // Fall through to auto-generate
    }
  }
  return extractThemes(book.description, count)
}

/**
 * Get FAQs from custom JSON or auto-generate
 */
export function getFAQs(book: BookDetail): FAQItem[] {
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
  return generateFAQs(book)
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

  return `A significant theme that shapes the narrative of ${title}.`
}
