import { useEffect, useRef, useState } from 'react'
import {
  REVIEW_ASSISTANT_KEY, chooseChat, connectedAssistants, handoffUrl, parseAssistant,
  type Assistant, type DiscussFailure, type DiscussState,
} from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'
import { ConnectAssistantDialog } from '../library/ReviewChapterButton'

export type { DiscussState }

const FAILURE: Record<DiscussFailure, string> = {
  empty: 'v2Reader.discussEmpty',
  unavailable: 'v2Reader.discussUnavailable',
  offline: 'v2Reader.discussOffline',
  signedOut: 'v2Reader.discussSignedOut',
  noBook: 'v2Reader.discussNoBook',
  timeout: 'v2Reader.discussTimeout',
  failed: 'v2Reader.discussFailed',
}

const remembered = (): Assistant | null => {
  try { return parseAssistant(localStorage.getItem(REVIEW_ASSISTANT_KEY)) } catch { return null }
}
const remember = (a: Assistant) => {
  try { localStorage.setItem(REVIEW_ASSISTANT_KEY, a) } catch { /* private mode: just don't remember */ }
}
const openChat = (a: Assistant, brief: string) => { window.open(handoffUrl(a, brief), '_blank', 'noopener,noreferrer') }

/**
 * The end-of-chapter Discuss of the web V2 reader (#1316): host UI over the frame, never injected into the book.
 * Two steps, each the reader's own click: "Discuss this chapter" asks the host to share the chapter (`onShare`:
 * the connected assistants are asked once there, then the share; a failure is said, with a retry), then "Open the
 * chat" opens their assistant with the share's id, decided from the assistants that run found (`state.grants`),
 * never from a cache. The chat opens inside that second click, so no popup blocker eats it, and never before the
 * server answered: no dead id. No assistant connected: the host's state says so, and this shows how to connect one
 * (`onDismiss` when it closes; the next click asks again). `title` is the contents entry's label, a book's own
 * text: rendered as text only.
 */
export function V2ChapterDiscuss({ title, state, onShare, onDismiss }: {
  title: string | null
  state: DiscussState | undefined
  onShare: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLSpanElement>(null)
  const openButton = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)
  // The share landed while this was on screen: the next step takes the focus, but only from this block's own button
  // (gone now: focus fell to the body) or the body: never from a dialog, an editor or the book the reader went to.
  const was = useRef(state?.phase)
  useEffect(() => {
    const active = document.activeElement
    const ours = !active || active === document.body || !!root.current?.contains(active)
    if (was.current === 'sharing' && state?.phase === 'ready' && ours) openButton.current?.focus()
    was.current = state?.phase
  }, [state?.phase])

  if (state?.phase === 'ready') {
    const { brief } = state.shared
    const two = connectedAssistants(state.grants).length === 2
    const open = () => {
      if (picking) return setPicking(false)
      const choice = chooseChat(state.grants, remembered())
      if (choice.kind === 'open') openChat(choice.assistant, brief)
      else setPicking(true)
    }
    const pick = (a: Assistant) => {
      remember(a)
      setPicking(false)
      openChat(a, brief)
    }
    return (
      <span ref={root} className="v2-reader__discuss review-chapter" data-testid="v2-discuss">
        <span role="status">{t(state.shared.cut ? 'v2Reader.discussCut' : 'v2Reader.discussShared')} </span>
        <button ref={openButton} type="button" data-testid="v2-discuss-open" onClick={open} aria-haspopup={picking ? 'menu' : undefined}>
          {t('v2Reader.discussOpen')}
        </button>
        {two && (
          <button type="button" className="review-chapter__switch" onClick={() => setPicking((p) => !p)} aria-label={t('chapterReview.switchAria')} aria-haspopup="menu" aria-expanded={picking}>
            <span aria-hidden="true">▾</span>
          </button>
        )}
        {picking && (
          <span className="review-chapter__menu" role="menu" aria-label={t('chapterReview.pickTitle')}>
            <span className="review-chapter__menu-title">{t('chapterReview.pickTitle')}</span>
            <button type="button" role="menuitem" onClick={() => pick('claude')}>{t('library.assistant.claude')}</button>
            <button type="button" role="menuitem" onClick={() => pick('chatgpt')}>{t('library.assistant.chatgpt')}</button>
          </span>
        )}
      </span>
    )
  }
  const sharing = state?.phase === 'sharing'
  return (
    <span ref={root} className="v2-reader__discuss" data-testid="v2-discuss">
      {state?.phase === 'failed' && <span role="alert">{t(FAILURE[state.reason])} </span>}
      <button
        type="button"
        data-testid="v2-discuss-share"
        onClick={onShare}
        disabled={sharing}
        aria-label={title && !sharing && state?.phase !== 'failed' ? t('v2Reader.discussAria', { title }) : undefined}
      >
        {sharing ? t('v2Reader.discussSharing') : state?.phase === 'failed' ? t('v2Reader.retry') : t('v2Reader.discuss')}
      </button>
      {state?.phase === 'connect' && <ConnectAssistantDialog onClose={onDismiss} />}
    </span>
  )
}
