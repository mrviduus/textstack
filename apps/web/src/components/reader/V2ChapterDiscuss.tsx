import { useEffect, useRef, useState } from 'react'
import { connectedAssistants, type V2DiscussFailure, type V2DiscussShared } from '@textstack/shared'
import { __resetAssistantGrants as forgetGrants, useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { useTranslation } from '../../hooks/useTranslation'
import { ConnectAssistantDialog } from '../library/ReviewChapterButton'

/** One chapter's Discuss, as the host holds it (undefined: not asked yet). */
export type V2DiscussState =
  | { phase: 'sharing' }
  | { phase: 'ready'; shared: V2DiscussShared }
  | { phase: 'failed'; reason: V2DiscussFailure }

const FAILURE: Record<V2DiscussFailure, string> = {
  empty: 'v2Reader.discussEmpty',
  unavailable: 'v2Reader.discussUnavailable',
  offline: 'v2Reader.discussOffline',
  signedOut: 'v2Reader.discussSignedOut',
  noBook: 'v2Reader.discussNoBook',
  timeout: 'v2Reader.discussTimeout',
  failed: 'v2Reader.discussFailed',
}

/**
 * The end-of-chapter Discuss of the web V2 reader (#1316): host UI over the frame, never injected into the book.
 * Two steps, each the reader's own click: "Discuss this chapter" shares the chapter's text with their account
 * (`onShare`; a failure is said, with a retry), then "Open the chat" opens their assistant with the share's id. The
 * chat opens inside that second click, so no popup blocker eats it, and never before the server answered: no dead id.
 * With no assistant connected (known before the click) nothing is shared: the first click shows how to connect one.
 * The launcher is never given an empty message: this component shows that dialog itself.
 * `title` is the contents entry's label, a book's own text: rendered as text only.
 */
export function V2ChapterDiscuss({ title, state, onShare }: { title: string | null; state: V2DiscussState | undefined; onShare: () => void }) {
  const { t } = useTranslation()
  const launcher = useAssistantLauncher()
  const open = useRef<HTMLButtonElement>(null)
  const ready = state?.phase === 'ready'
  const [checking, setChecking] = useState(false)
  const [connect, setConnect] = useState(false)
  // The share landed while this was on screen: the next step takes the focus (the button the reader pressed is
  // gone). Not on a mount already shared (the reader paged back to the chapter's end): focus stays in the book,
  // where Space turns the page.
  const was = useRef(state?.phase)
  useEffect(() => {
    if (was.current === 'sharing' && ready) open.current?.focus()
    was.current = state?.phase
  }, [state?.phase, ready])
  // A connect dialog closed: the reader may have connected one. The grants are asked again at once, so the next
  // click finds them known and the chat opens inside it (an open after a wait is what popup blockers eat).
  const recheck = () => {
    setChecking(true)
    void launcher.prefetch().finally(() => setChecking(false))
  }

  if (state?.phase === 'ready') {
    const brief = () => state.shared.brief
    return (
      <span className="v2-reader__discuss review-chapter" data-testid="v2-discuss">
        <span role="status">{t(state.shared.cut ? 'v2Reader.discussCut' : 'v2Reader.discussShared')} </span>
        <button
          ref={open}
          type="button"
          data-testid="v2-discuss-open"
          disabled={checking}
          onClick={() => { if (launcher.pending) launcher.cancelPick(); else void launcher.launch(brief) }}
          aria-haspopup={launcher.pending ? 'menu' : undefined}
        >
          {t('v2Reader.discussOpen')}
        </button>
        {launcher.canSwitch && (
          <button type="button" className="review-chapter__switch" onClick={() => launcher.choose(brief)} aria-label={t('chapterReview.switchAria')} aria-haspopup="menu" aria-expanded={launcher.pending}>
            <span aria-hidden="true">▾</span>
          </button>
        )}
        {launcher.pending && (
          <span className="review-chapter__menu" role="menu" aria-label={t('chapterReview.pickTitle')}>
            <span className="review-chapter__menu-title">{t('chapterReview.pickTitle')}</span>
            <button type="button" role="menuitem" onClick={() => launcher.pick('claude')}>{t('library.assistant.claude')}</button>
            <button type="button" role="menuitem" onClick={() => launcher.pick('chatgpt')}>{t('library.assistant.chatgpt')}</button>
          </span>
        )}
        {launcher.connect && <ConnectAssistantDialog onClose={() => { launcher.closeConnect(); recheck() }} />}
      </span>
    )
  }
  const sharing = state?.phase === 'sharing'
  const noAssistant = !!launcher.grants && connectedAssistants(launcher.grants).length === 0
  const start = () => { if (noAssistant) setConnect(true); else onShare() }
  // The launcher keeps the answer "none" it was given: forgotten here, so the check after the dialog asks the server.
  const closeConnect = () => {
    setConnect(false)
    forgetGrants()
    recheck()
  }
  return (
    <span className="v2-reader__discuss" data-testid="v2-discuss">
      {state?.phase === 'failed' && <span role="alert">{t(FAILURE[state.reason])} </span>}
      <button
        type="button"
        data-testid="v2-discuss-share"
        onClick={start}
        disabled={sharing || checking}
        aria-label={title && !sharing && state?.phase !== 'failed' ? t('v2Reader.discussAria', { title }) : undefined}
      >
        {sharing ? t('v2Reader.discussSharing') : state?.phase === 'failed' ? t('v2Reader.retry') : t('v2Reader.discuss')}
      </button>
      {connect && <ConnectAssistantDialog onClose={closeConnect} />}
    </span>
  )
}
