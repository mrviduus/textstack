import { useEffect, useRef, useState } from 'react'
import { buildChapterDiscussBrief, buildHandoffBrief, type Assistant, type HandoffBook } from '@textstack/shared'
import { useAssistantLauncher } from '../../hooks/useAssistantLauncher'
import { useTranslation } from '../../hooks/useTranslation'
import { chapterReviewPath } from '../../hooks/useBookReviews'
import { LocalizedLink } from '../LocalizedLink'
import { ConnectAssistantDialog } from './ReviewChapterButton'

/**
 * "✦ Assistant ▾" next to Continue Reading — the one way from a book page into the reader's own
 * Claude or ChatGPT. ONE discuss item: the chapter the reader is on when there is one (plus "Open
 * review" when it is reviewed — re-discussing overwrites it), else the whole book. Never both.
 * Both go through `useAssistantLauncher`, the same path as the chapter-row Discuss.
 */
interface Props {
  /** The book and where the reader is — `buildHandoffBrief` input. Upload: bookId; catalog: editionId + slug. */
  book: HandoffBook
  /** From `currentReviewChapter`; null → discuss the whole book instead. */
  current: { slug: string; title: string; reviewed: boolean } | null
}

export function AssistantMenu({ book, current }: Props) {
  const { t } = useTranslation()
  const launcher = useAssistantLauncher({ eager: false })
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = () => { setOpen(false); launcher.cancelPick() }

  const toggle = () => {
    if (open) return close()
    setOpen(true)
    // Opening the menu is the gesture before the item click: by then the grants are known and the
    // click can open the chat synchronously.
    void launcher.prefetch()
  }

  const run = async (brief: () => string) => {
    // 'pick' keeps the menu open on the Claude / ChatGPT choice.
    if ((await launcher.launch(brief)) !== 'pick') setOpen(false)
  }

  const discuss = () => buildHandoffBrief(book)
  const discussChapter = (slug: string, title: string) => () => buildChapterDiscussBrief({
    title: book.title, author: book.author, bookId: book.bookId, editionId: book.editionId, slug: book.slug,
    chapterSlug: slug, chapterTitle: title,
  })
  const reviewPath = (slug: string) => book.bookId
    ? chapterReviewPath({ userBookId: book.bookId }, slug)
    : chapterReviewPath({ bookSlug: book.slug ?? '' }, slug)

  const chat = (a: Assistant) => t(a === 'claude' ? 'library.assistant.claude' : 'library.assistant.chatgpt')

  return (
    <span className="assistant-menu" ref={root}>
      <button
        type="button"
        className="assistant-menu__btn"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span aria-hidden="true">✦ </span>{t('library.assistant.button')}<span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div className="assistant-menu__list" role="menu" aria-label={t('library.assistant.button')}>
          {launcher.pending ? (
            <>
              <span className="assistant-menu__title">{t('library.assistant.pickTitle')}</span>
              {(['claude', 'chatgpt'] as const).map(a => (
                <button key={a} type="button" role="menuitem" className="assistant-menu__item"
                  onClick={() => { launcher.pick(a); setOpen(false) }}>
                  {chat(a)}
                </button>
              ))}
            </>
          ) : (
            <>
              {current ? (
                <>
                  {current.reviewed && (
                    <LocalizedLink to={reviewPath(current.slug)} role="menuitem" className="assistant-menu__item" onClick={() => setOpen(false)}>
                      {t('library.assistant.openCurrentReview')}
                      <span className="assistant-menu__sub">{current.title}</span>
                    </LocalizedLink>
                  )}
                  <button type="button" role="menuitem" className="assistant-menu__item"
                    onClick={() => void run(discussChapter(current.slug, current.title))}>
                    {t('library.assistant.reviewCurrent')}
                    <span className="assistant-menu__sub">{current.title}</span>
                  </button>
                </>
              ) : (
                <button type="button" role="menuitem" className="assistant-menu__item" onClick={() => void run(discuss)}>
                  {t('library.assistant.discuss')}
                </button>
              )}
              {launcher.canSwitch && (
                <div className="assistant-menu__chat" role="group" aria-label={t('library.assistant.chatIn')}>
                  <span>{t('library.assistant.chatIn')}</span>
                  {(['claude', 'chatgpt'] as const).map(a => (
                    <button key={a} type="button" aria-pressed={launcher.remembered === a} onClick={() => launcher.remember(a)}>
                      {chat(a)}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {launcher.connect && <ConnectAssistantDialog onClose={launcher.closeConnect} />}
    </span>
  )
}
