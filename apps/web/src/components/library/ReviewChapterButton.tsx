import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MCP_ENDPOINT, REVIEW_ASSISTANT_KEY, buildChapterReviewBrief, chooseChat, handoffUrl, parseAssistant,
  type Assistant, type ChapterReviewBriefInput, type OAuthGrant,
} from '@textstack/shared'
import { listOAuthGrants } from '../../api/oauth'
import { useTranslation } from '../../hooks/useTranslation'
import { LocalizedLink } from '../LocalizedLink'

/**
 * "Review" — opens the reader's own Claude or ChatGPT with a chapter-review brief (chapter-review.md §12).
 *
 * Which chat: `/me/oauth/grants`. One assistant connected → straight there; both → a two-item menu,
 * remembered per device; none → a connect dialog instead of a chat that cannot reach TextStack.
 *
 * The grants are fetched once per page and shared by every button on it (a chapter list has dozens),
 * and kept synchronously so the click can `window.open` inside the user gesture — an open after an
 * await is what popup blockers eat.
 */
let cachedGrants: OAuthGrant[] | null = null
let grantsPromise: Promise<OAuthGrant[]> | null = null

function loadGrants(): Promise<OAuthGrant[]> {
  grantsPromise ??= listOAuthGrants()
    .then(g => (cachedGrants = g))
    // A guest (no account → no grants) or a failed call both mean "nothing we can open".
    .catch(() => (cachedGrants = []))
  return grantsPromise
}

/** Forget the grants — after the connect dialog, the reader may be about to connect one. */
function resetGrants() { cachedGrants = null; grantsPromise = null }

/** Test seam. */
export const __resetReviewGrants = resetGrants

function rememberedAssistant(): Assistant | null {
  try { return parseAssistant(localStorage.getItem(REVIEW_ASSISTANT_KEY)) } catch { return null }
}

function openChat(assistant: Assistant, brief: string) {
  window.open(handoffUrl(assistant, brief), '_blank', 'noopener,noreferrer')
}

interface Props extends ChapterReviewBriefInput {
  /** Button text; defaults to "Review". */
  label?: string
  className?: string
}

export function ReviewChapterButton({ label, className, ...input }: Props) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState(false)
  const [connect, setConnect] = useState(false)

  useEffect(() => { void loadGrants() }, [])

  const brief = () => buildChapterReviewBrief(input)

  const decide = (grants: OAuthGrant[]) => {
    const choice = chooseChat(grants, rememberedAssistant())
    if (choice.kind === 'open') openChat(choice.assistant, brief())
    else if (choice.kind === 'pick') setMenu(m => !m)
    else { resetGrants(); setConnect(true) }
  }

  const onClick = () => {
    if (cachedGrants) decide(cachedGrants)
    else void loadGrants().then(decide)
  }

  const pick = (assistant: Assistant) => {
    try { localStorage.setItem(REVIEW_ASSISTANT_KEY, assistant) } catch { /* private mode: just don't remember */ }
    setMenu(false)
    openChat(assistant, brief())
  }

  return (
    <span className="review-chapter">
      <button
        type="button"
        className={className ?? 'review-chapter__btn'}
        onClick={onClick}
        aria-label={label ? undefined : t('chapterReview.reviewAria', { title: input.chapterTitle })}
        aria-haspopup={menu ? 'menu' : undefined}
      >
        {label ?? t('chapterReview.review')}
      </button>
      {menu && (
        <span className="review-chapter__menu" role="menu" aria-label={t('chapterReview.pickTitle')}>
          <span className="review-chapter__menu-title">{t('chapterReview.pickTitle')}</span>
          <button type="button" role="menuitem" onClick={() => pick('claude')}>{t('library.discuss.claude')}</button>
          <button type="button" role="menuitem" onClick={() => pick('chatgpt')}>{t('library.discuss.chatgpt')}</button>
        </span>
      )}
      {connect && <ConnectAssistantDialog onClose={() => setConnect(false)} />}
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
