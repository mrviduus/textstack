// Chapter-nav bar for the section-at-a-time reader (slice 7 consumer).
// Renders Prev / Next buttons + chapter label + progress counter.
// Pure presentation — caller owns navigation + visibility.

interface Props {
  chapterTitle: string
  /** 1-based positional index of the active chapter (NOT catalog chapterNumber, which is 0-based). */
  chapterNumber: number | null
  totalChapters: number | null
  /** Percent 0..1 of current chapter read (intra-chapter). */
  chapterProgress: number
  /** null → disabled. */
  onPrev: (() => void) | null
  /** null → disabled. */
  onNext: (() => void) | null
  /** Last chapter (no onNext): the next button finishes the book instead. */
  onFinish?: () => void
  finishLabel?: string
  prevLabel?: string
  nextLabel?: string
}

export function ReaderNav({
  chapterTitle,
  chapterNumber,
  totalChapters,
  chapterProgress,
  onPrev,
  onNext,
  onFinish,
  finishLabel = 'Finish book',
  prevLabel = 'Previous chapter',
  nextLabel = 'Next chapter',
}: Props) {
  const next = onNext ?? onFinish ?? null
  const pct = Math.round(Math.max(0, Math.min(1, chapterProgress)) * 100)
  const counter =
    chapterNumber !== null && totalChapters !== null && totalChapters > 0
      ? `${chapterNumber} / ${totalChapters}`
      : null

  return (
    <nav className="reader-nav" aria-label="Chapter navigation">
      <div className="reader-nav__progress" aria-hidden="true">
        <div
          className="reader-nav__progress-bar"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Chapter progress: ${pct}%`}
        />
      </div>

      <div className="reader-nav__row">
        <button
          type="button"
          className="reader-nav__btn reader-nav__btn--prev"
          onClick={onPrev ?? undefined}
          disabled={!onPrev}
          aria-label={prevLabel}
        >
          <span aria-hidden="true">‹</span>
        </button>

        <div className="reader-nav__info">
          <span className="reader-nav__title" title={chapterTitle}>
            {chapterTitle}
          </span>
          {counter && (
            <span className="reader-nav__counter" aria-label={`Chapter ${chapterNumber} of ${totalChapters}`}>
              {counter}
            </span>
          )}
        </div>

        <button
          type="button"
          className="reader-nav__btn reader-nav__btn--next"
          onClick={next ?? undefined}
          disabled={!next}
          aria-label={onNext ? nextLabel : finishLabel}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </nav>
  )
}
