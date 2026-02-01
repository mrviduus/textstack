import type { AuthorDetail } from '../types/api'

export interface FAQItem {
  question: string
  answer: string
}

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
 * Extract theme keywords from bio text
 */
function extractThemes(bio: string | null, count = 4): string[] {
  if (!bio) return []

  const words = bio
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
 * Generate "About" section text
 */
export function generateAboutText(author: AuthorDetail): string {
  if (author.seoAboutText) {
    return author.seoAboutText
  }

  if (author.bio) {
    const sentences = author.bio.replace(/<[^>]*>/g, '').split(/(?<=[.!?])\s+/)
    return sentences.slice(0, 2).join(' ')
  }

  return `${author.name} is a distinguished author whose works continue to captivate readers worldwide.`
}

/**
 * Generate "Why relevant" section text
 */
export function generateRelevanceText(author: AuthorDetail): string {
  if (author.seoRelevanceText) {
    return author.seoRelevanceText
  }

  const themes = extractThemes(author.bio, 2)
  const themeText = themes.length > 0 ? themes.join(' and ').toLowerCase() : 'timeless human experiences'

  return `${author.name}'s works remain relevant today because they explore ${themeText} that transcend time and culture. Their insights into human nature continue to resonate with modern readers.`
}

/**
 * Get themes from custom JSON or auto-extract from bio
 */
export function getThemes(author: AuthorDetail, count = 4): string[] {
  if (author.seoThemesJson) {
    try {
      const themes = JSON.parse(author.seoThemesJson)
      if (Array.isArray(themes)) return themes.slice(0, count)
    } catch {
      // Fall through to auto-generate
    }
  }
  return extractThemes(author.bio, count)
}

/**
 * Generate default FAQs for author
 */
function generateFAQs(author: AuthorDetail): FAQItem[] {
  const faqs: FAQItem[] = []

  faqs.push({
    question: `Who is ${author.name}?`,
    answer: author.bio
      ? author.bio.replace(/<[^>]*>/g, '').split(/(?<=[.!?])\s+/).slice(0, 1).join(' ')
      : `${author.name} is an author whose works are available on TextStack.`,
  })

  faqs.push({
    question: `How many books by ${author.name} are on TextStack?`,
    answer: `TextStack currently has ${author.editions.length} ${author.editions.length === 1 ? 'book' : 'books'} by ${author.name}.`,
  })

  faqs.push({
    question: `Can I read ${author.name}'s books for free?`,
    answer: `Yes, all books by ${author.name} on TextStack are available to read for free.`,
  })

  if (author.editions.length > 0) {
    const titles = author.editions.slice(0, 3).map((e) => e.title)
    faqs.push({
      question: `What are ${author.name}'s most popular books?`,
      answer: `Some notable works by ${author.name} include ${titles.join(', ')}.`,
    })
  }

  return faqs
}

/**
 * Get FAQs from custom JSON or auto-generate
 */
export function getFAQs(author: AuthorDetail): FAQItem[] {
  if (author.seoFaqsJson) {
    try {
      const faqs = JSON.parse(author.seoFaqsJson)
      if (Array.isArray(faqs)) {
        return faqs
          .map((f: { q?: string; question?: string; a?: string; answer?: string }) => ({
            question: f.q || f.question || '',
            answer: f.a || f.answer || '',
          }))
          .filter((f: FAQItem) => f.question && f.answer)
      }
    } catch {
      // Fall through to auto-generate
    }
  }
  return generateFAQs(author)
}

/**
 * Generate theme description for author
 */
export function generateThemeDescription(theme: string, authorName: string): string {
  const themeDescriptions: Record<string, string> = {
    love: 'Explores the complexities of romantic and familial love',
    death: 'Confronts mortality and its impact on the human experience',
    justice: 'Examines moral righteousness and the pursuit of fairness',
    childhood: 'Captures the wonder and innocence of youth',
    adventure: 'Takes readers on exciting journeys and discoveries',
    fantasy: 'Creates imaginative worlds beyond reality',
    nature: 'Depicts the relationship between humans and the natural world',
    morality: 'Examines ethical dilemmas and moral choices',
    society: 'Critiques social structures and conventions',
    identity: 'Questions the nature of self and personal authenticity',
  }

  const lowerTheme = theme.toLowerCase()
  if (themeDescriptions[lowerTheme]) {
    return `${themeDescriptions[lowerTheme]} in ${authorName}'s work.`
  }

  return `A recurring theme throughout ${authorName}'s writing.`
}
