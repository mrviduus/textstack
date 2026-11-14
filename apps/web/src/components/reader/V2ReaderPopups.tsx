import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { V2Popup } from '../../../../mobile/src/lib/v2reader/wordPopup.mjs'
import type { V2Rect } from '../../../../mobile/src/lib/v2reader/selection.mjs'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useTranslation } from '../../hooks/useTranslation'
import { useTranslationPopup } from '../../hooks/useTranslationPopup'
import { useExplainPopup } from '../../hooks/useExplainPopup'
import { fetchWordBubble, type WordBubbleFetchFields } from '../../lib/wordBubbleFetch'
import { WordPopup } from './WordPopup'
import { SelectionToolbar } from './SelectionToolbar'
import { TranslationPopup } from './TranslationPopup'
import { ExplanationPopup } from './ExplanationPopup'

interface Props {
  /** What is open (wordPopup.mjs `popupStep`, run by the host on the page's messages). */
  popup: V2Popup | null
  /** The reader frame: the page's rects are in its viewport. */
  frame: RefObject<HTMLIFrameElement | null>
  /** `opened.lang` through readLang, else `en` (the legacy reader's default). */
  bookLanguage: string
  /** The toolbar's Highlight; absent where the host offers none (an image or PDF book, the server's highlights not in yet). */
  onHighlight?: () => void
  /** The word popup or the toolbar closed (`selectionDone` false), or the selection's actions are done (true): the page's selection goes, and the toolbar if it is still what is open (never a newer word popup). */
  onClose: (selectionDone: boolean) => void
}

/**
 * The V2 reader's word popup, selection toolbar, translation popup and streamed explain on the web (#1269): the
 * legacy reader's components and hooks, fetched here by the host (the page has no network). Listen is the TTS
 * slice's (#1272): neither the popup's speaker nor the toolbar's Listen is shown yet. No word is saved (vocabulary, §2.5).
 */
export function V2ReaderPopups({ popup, frame, bookLanguage, onHighlight, onClose }: Props) {
  const { t } = useTranslation()
  const { nativeLanguage, setNativeLanguage, hasConfirmedLanguage } = useNativeLanguage()
  // As ReaderHighlights' resolveTargetLang: null (definition mode) when the reader's language is the book's.
  const targetLang = nativeLanguage !== bookLanguage ? nativeLanguage : null
  // The frame's viewport → this document's (the legacy components position by the window's coordinates).
  const toHost = (r: V2Rect) => {
    const f = frame.current?.getBoundingClientRect()
    return new DOMRect(r.x + (f?.left ?? 0), r.y + (f?.top ?? 0), r.w, r.h)
  }
  const rect = useMemo(() => (popup ? toHost(popup.rect) : null), [popup])

  // The word: its translation (or, in definition mode, its contextual explanation), refetched on a language change.
  // Keyed by the request: a new word (or language) renders loading from its first frame, never the previous gloss.
  const word = popup?.kind === 'word' ? popup : null
  const explainInContext = !targetLang && hasConfirmedLanguage
  const request = useMemo(() => word && { word, targetLang, explainInContext }, [word, targetLang, explainInContext])
  const [fetched, setFetched] = useState<WordBubbleFetchFields & { for?: unknown; failed?: boolean }>({})
  const shown = fetched.for === request ? fetched : { translationLoading: !!targetLang, definitionLoading: explainInContext }
  useEffect(() => {
    if (!request) return
    const ctrl = new AbortController()
    fetchWordBubble({
      word: request.word.word, bookLanguage, targetLang, explainInContext, signal: ctrl.signal, sentence: request.word.sentence,
      // A failed translation is the one patch that ends the loading without a `translation`: said in the popup.
      patch: (f) => setFetched((p) => {
        const mine = p.for === request ? p : { translationLoading: !!targetLang, definitionLoading: explainInContext }
        return { ...mine, ...f, for: request, failed: !!mine.failed || ('translationLoading' in f && !('translation' in f)) }
      }),
    })
    return () => ctrl.abort()
  }, [request, bookLanguage])

  const selection = popup?.kind === 'selection' ? popup : null
  // Their own close ends the selection in the page (the legacy reader's clearSelection on close).
  const translationPopup = useTranslationPopup({ bookLanguage, targetLang, onClose: () => onClose(true) })
  const explainPopup = useExplainPopup({ editionId: '', nativeLanguage, onClose: () => onClose(true) })
  // The selection dismissed by a tap in the book, or a word tapped, closes them (the legacy reader shows one at a time).
  useEffect(() => {
    if (popup?.kind === 'selection') return
    if (translationPopup.show) translationPopup.close()
    if (explainPopup.show) explainPopup.close()
  }, [popup?.kind])

  return (
    <>
      {word && !translationPopup.show && !explainPopup.show && (
        <WordPopup
          word={word.word}
          translation={shown.failed ? t('v2Reader.translationFailed') : shown.translation ?? null}
          translationLoading={!!shown.translationLoading}
          definition={shown.definition ?? null}
          definitionLoading={!!shown.definitionLoading}
          rect={rect}
          containerRef={frame}
          onClose={() => onClose(false)}
          isSaved={false}
          nativeLanguage={nativeLanguage}
          onChangeNativeLanguage={setNativeLanguage}
          hasConfirmedLanguage={hasConfirmedLanguage}
          bookLanguage={bookLanguage}
          t={t}
        />
      )}
      {selection && !translationPopup.show && !explainPopup.show && (
        <SelectionToolbar
          rect={rect}
          text={selection.text}
          containerRef={frame}
          colors={['yellow']}
          hideHighlight={!onHighlight}
          onHighlight={() => { onHighlight?.(); onClose(false) }}
          onTranslate={() => translationPopup.open(selection.text, rect, { sentence: selection.sentence })}
          onExplain={() => explainPopup.openFromSelection(selection.text, rect, selection.sentence)}
          onCopy={() => onClose(true)}
          tooLong={selection.tooLong}
        />
      )}
      {translationPopup.show && (
        <TranslationPopup
          text={translationPopup.text}
          translatedText={translationPopup.translatedText}
          isLoading={translationPopup.isTranslating}
          error={translationPopup.error}
          sourceLang={translationPopup.sourceLang}
          targetLang={translationPopup.targetLang}
          languages={translationPopup.languages}
          rect={translationPopup.rect}
          containerRef={frame}
          onSourceLangChange={translationPopup.setSourceLang}
          onTargetLangChange={translationPopup.setTargetLang}
          onClose={translationPopup.close}
        />
      )}
      {explainPopup.show && (
        <ExplanationPopup
          word={explainPopup.word}
          explanation={explainPopup.explanation}
          isLoading={explainPopup.isExplaining}
          error={explainPopup.error}
          rect={explainPopup.rect}
          containerRef={frame}
          onClose={explainPopup.close}
        />
      )}
    </>
  )
}
