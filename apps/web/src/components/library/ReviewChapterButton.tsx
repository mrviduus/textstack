import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MCP_ENDPOINT, buildChapterDiscussBrief, type ChapterReviewBriefInput } from '@textstack/shared'
import { useAssistantLauncher, __resetAssistantGrants } from '../../hooks/useAssistantLauncher'
import { useTranslation } from '../../hooks/useTranslation'
import { LocalizedLink } from '../LocalizedLink'

/**
 * "Discuss" — opens the reader's own Claude or ChatGPT with a chapter brief (talk, then the review) (chapter-review.md §12).
 * Which chat is `useAssistantLauncher` (shared with the book page's Assistant menu); with both
 * connected a ▾ beside the button switches — the new pick is remembered per device.
 */

/** Test seam. */
export const __resetReviewGrants = __resetAssistantGrants

interface Props extends ChapterReviewBriefInput {
  /** Button text; defaults to "Discuss". */
  label?: string
  className?: string
}

export function ReviewChapterButton({ label, className, ...input }: Props) {
  const { t } = useTranslation()
  const launcher = useAssistantLauncher()
  const brief = () => buildChapterDiscussBrief(input)

  return (
    <span className="review-chapter">
      <button
        type="button"
        className={className ?? 'review-chapter__btn'}
        onClick={() => { if (launcher.pending) launcher.cancelPick(); else void launcher.launch(brief) }}
        aria-label={label ? undefined : t('chapterReview.reviewAria', { title: input.chapterTitle })}
        aria-haspopup={launcher.pending ? 'menu' : undefined}
      >
        {label ?? t('chapterReview.review')}
      </button>
      {launcher.canSwitch && (
        <button
          type="button"
          className="review-chapter__switch"
          onClick={() => launcher.choose(brief)}
          aria-label={t('chapterReview.switchAria')}
          aria-haspopup="menu"
          aria-expanded={launcher.pending}
        >
          ▾
        </button>
      )}
      {launcher.pending && (
        <span className="review-chapter__menu" role="menu" aria-label={t('chapterReview.pickTitle')}>
          <span className="review-chapter__menu-title">{t('chapterReview.pickTitle')}</span>
          <button type="button" role="menuitem" onClick={() => launcher.pick('claude')}>{t('library.assistant.claude')}</button>
          <button type="button" role="menuitem" onClick={() => launcher.pick('chatgpt')}>{t('library.assistant.chatgpt')}</button>
        </span>
      )}
      {launcher.connect && <ConnectAssistantDialog onClose={launcher.closeConnect} />}
    </span>
  )
}

/** Nothing connected: the one-step instructions from the connect page, a Copy button and a link there. */
export function ConnectAssistantDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MCP_ENDPOINT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable — the URL is selectable */ }
  }

  return createPortal(
    <div className="profile-overlay" onClick={onClose}>
      <div
        className="profile-modal review-connect"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-connect-title"
      >
        <button className="profile-modal__close" onClick={onClose} aria-label={t('chapterReview.connect.close')}>&times;</button>
        <div className="profile-modal__body">
          <h2 className="profile-modal__title" id="review-connect-title">{t('chapterReview.connect.title')}</h2>
          <p>{t('chapterReview.connect.lead')}</p>
          <div className="review-connect__url">
            <code>{MCP_ENDPOINT}</code>
            <button type="button" className="review-chapter__btn" onClick={copy}>
              {copied ? t('chapterReview.connect.copied') : t('chapterReview.connect.copy')}
            </button>
          </div>
          <ul className="review-connect__steps">
            <li><strong>{t('connect.oneStep.claudeLabel')}:</strong> {t('connect.oneStep.claudeHow')}</li>
            <li><strong>{t('connect.oneStep.chatgptLabel')}:</strong> {t('connect.oneStep.chatgptHow')}</li>
          </ul>
          <LocalizedLink to="/mcp" className="review-connect__more" onClick={onClose}>
            {t('chapterReview.connect.more')}
          </LocalizedLink>
        </div>
      </div>
    </div>,
    document.body,
  )
}
