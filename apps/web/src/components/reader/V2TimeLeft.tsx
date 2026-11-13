import { placeTimeLeftLabel, timeLeftAt } from '@textstack/shared'
import { useFetchedReadingPace } from '../../hooks/useReadingPace'
import { useTranslation } from '../../hooks/useTranslation'

/** What the V2 reader's bottom bar needs of a `relocate` (through `readRelocate`) for the time left. */
export interface V2TimePlace { fraction: number | null; sectionEnd: number | null; words: number | null }

/** The book's percent as the bottom bar shows it: a dash when the page gave no fraction. */
export const v2Percent = (fraction: number | null) => (fraction == null ? '—' : `${Math.round(fraction * 100)}%`)

/**
 * Time left in the chapter and the book (#1262), from the reader's pace (fetched here: the page has no network).
 * Nothing until the pace call has answered, and for a book the page has no word estimate of (CBZ, PDF).
 */
export function V2TimeLeft({ fraction, sectionEnd, words }: V2TimePlace) {
  const { t } = useTranslation()
  const wpm = useFetchedReadingPace()
  const label = placeTimeLeftLabel(timeLeftAt({ fraction, sectionEnd, totalWords: words, wpm }), t)
  return label ? <span className="reader-footer__counter v2-reader__time-left" data-testid="v2-time-left">{label}</span> : null
}
