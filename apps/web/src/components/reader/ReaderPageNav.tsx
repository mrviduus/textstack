interface Props {
  direction: 'prev' | 'next'
  disabled: boolean
  onClick: () => void
}

export function ReaderPageNav({ direction, disabled, onClick }: Props) {
  const isPrev = direction === 'prev'

  return (
    <div
      className={`reader-page-nav reader-page-nav--${direction}`}
      onClick={disabled ? undefined : onClick}
    >
      <button
        className="reader-page-nav__btn"
        disabled={disabled}
        aria-label={isPrev ? 'Previous page' : 'Next page'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          {isPrev ? (
            <path d="M15 18l-6-6 6-6" />
          ) : (
            <path d="M9 18l6-6-6-6" />
          )}
        </svg>
      </button>
    </div>
  )
}
