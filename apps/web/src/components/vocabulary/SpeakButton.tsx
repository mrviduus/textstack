import { useTranslation } from '../../hooks/useTranslation'

interface SpeakButtonProps {
  onClick: () => void
  isPlaying?: boolean
  /**
   * #1272: the V2 reader's Listen state. `loading`: the audio is fetched, a press cancels it (a spinner, said so);
   * `playing`: a press stops it. Absent: the legacy look (`isPlaying` pulses).
   */
  state?: 'idle' | 'loading' | 'playing'
  size?: number
  className?: string
}

const LABEL = { idle: 'reader.selectionToolbar.listen', loading: 'reader.selectionToolbar.listenLoading', playing: 'reader.selectionToolbar.listenStop' } as const

export function SpeakButton({ onClick, isPlaying, state, size = 16, className = '' }: SpeakButtonProps) {
  const { t } = useTranslation()
  const s = state ?? 'idle'
  return (
    <button
      className={`speak-btn ${isPlaying || s === 'playing' ? 'speak-btn--playing' : ''} ${className}`}
      onMouseDown={e => e.preventDefault()}
      onClick={e => { e.stopPropagation(); onClick() }}
      title={t(LABEL[s])}
      aria-label={t(LABEL[s])}
      aria-busy={s === 'loading' || undefined}
      type="button"
    >
      <SpeakStateIcon state={s} size={size} />
    </button>
  )
}

/** The speaker, a spinner while loading, a stop square while playing (the selection toolbar's Listen too). */
export function SpeakStateIcon({ state, size = 16 }: { state: 'idle' | 'loading' | 'playing'; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {state === 'loading' ? (
        <path className="speak-btn__spinner" d="M21 12a9 9 0 1 1-6.22-8.56" />
      ) : state === 'playing' ? (
        <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
      ) : (
        <>
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  )
}
