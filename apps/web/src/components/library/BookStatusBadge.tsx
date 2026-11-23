import { useTranslation } from '../../hooks/useTranslation'

export type BookStatusVariant = 'failed' | 'new' | 'finished'

interface BookStatusBadgeProps {
  variant: BookStatusVariant
  onClick?: () => void
  title?: string
}

function Inner({ variant, label }: { variant: BookStatusVariant; label: string }) {
  return (
    <>
      {variant === 'finished' && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className="book-status-badge__text">{label}</span>
    </>
  )
}

export function BookStatusBadge({ variant, onClick, title }: BookStatusBadgeProps) {
  const { t } = useTranslation()
  const label = t(`library.badge.${variant}`)
  const className = `book-status-badge book-status-badge--${variant}`

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        title={title}
        aria-label={label}
      >
        <Inner variant={variant} label={label} />
      </button>
    )
  }

  return (
    <span className={className} title={title} aria-label={label}>
      <Inner variant={variant} label={label} />
    </span>
  )
}
