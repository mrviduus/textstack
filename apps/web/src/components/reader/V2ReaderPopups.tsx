import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { V2Popup } from '../../../../mobile/src/lib/v2reader/wordPopup.mjs'
import type { V2Rect } from '../../../../mobile/src/lib/v2reader/selection.mjs'
import { saveOutcome } from '../../../../mobile/src/lib/v2reader/vocabSave.mjs'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useAuth } from '../../context/AuthContext'
import { useReaderVocabulary } from '../../hooks/useReaderVocabulary'
import { promoteLookup, restoreWord } from '../../api/vocabulary'
import { emitDataChange } from '../../lib/dataEvents'
import { normalizeVocabKey } from '../../lib/vocabKey'
import { Toast } from '../Toast'
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
  /** The server book on screen (the production route): a tapped word is saved to the vocabulary with it. None: nothing is saved (the dev route). */
  bookId?: string
  /** Its title as the page read it (untrusted: React text, and the example's `bookTitle`, clipped by the save). */
  bookTitle?: string
  /** The toolbar's Highlight; absent where the host offers none (an image or PDF book, the server's highlights not in yet). */
  onHighlight?: () => void
  /** The word popup or the toolbar closed (`selectionDone` false), or the selection's actions are done (true): the page's selection goes, and the toolbar if it is still what is open (never a newer word popup). */
  onClose: (selectionDone: boolean) => void
}

/**
 * The V2 reader's word popup, selection toolbar, translation popup and streamed explain on the web (#1269): the
 * legacy reader's components and hooks, fetched here by the host (the page has no network). Listen is the TTS
 * slice's (#1272): neither the popup's speaker nor the toolbar's Listen is shown yet. A tapped word is saved to the
 * vocabulary as the legacy reader saves it (#1270): `useReaderVocabulary` (guests' words, the session minted on the
 * third, nudges at 3 and 10), the outcomes through vocabSave.mjs.
 */
export function V2ReaderPopups({ popup, frame, bookLanguage, bookId, bookTitle, onHighlight, onClose }: Props) {
  const { t } = useTranslation()
  const { openAuthModal } = useAuth()
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

  // #1270: the legacy reader's auto-save. A word tapped is saved with its sentence, the book and (once fetched) its
  // translation, after the reader confirmed a native language (otherwise the popup's footer asks, and picking one
  // saves the word on screen). Once per word key while this book is open, unless the save failed (a re-tap retries).
  const vocab = useReaderVocabulary(bookLanguage, targetLang)
  const { vocabMap, addWord, updateTranslation, recordSavedWord } = vocab
  const tried = useRef(new Set<string>())
  const [saving, setSaving] = useState<string | null>(null)
  const [lookup, setLookup] = useState<{ word: string; id: string; kind: 'lookup' | 'lookup_pending'; tapsRemaining: number | null } | null>(null)
  const [addAnywayBusy, setAddAnywayBusy] = useState(false)
  const [deleted, setDeleted] = useState<{ id: string; word: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!word || !bookId || !hasConfirmedLanguage) return
    const key = normalizeVocabKey(word.word)
    if (vocabMap.has(key) || tried.current.has(key)) return
    tried.current.add(key)
    setSaving(word.word)
    addWord({
      word: word.word, language: bookLanguage, userBookId: bookId, sentence: word.sentence || undefined,
      bookTitle: bookTitle || undefined, nativeLanguage, translation: fetched.for === request ? fetched.translation ?? null : null,
    }).then((resp) => {
      const o = saveOutcome(resp)
      if (o.kind === 'deleted') setDeleted({ id: o.id, word: word.word })
      else if (o.kind === 'pending') setToast(t('reader.vocab.queuedForTomorrow'))
      else if (o.kind === 'lookup') setLookup({ word: word.word, id: o.id, kind: o.lookup, tapsRemaining: o.tapsRemaining })
    }, () => { tried.current.delete(key) })
      .finally(() => setSaving((s) => (s === word.word ? null : s)))
  }, [word, bookId, hasConfirmedLanguage])
  // The translation follows the save (TR-2: it fills an untranslated word, never replaces one), in the language the
  // popup opened in: one switched to mid-popup is display-only, as in the legacy reader.
  const openedLang = useMemo(() => targetLang, [word])
  useEffect(() => {
    if (word && shown.translation && !shown.failed && targetLang === openedLang) updateTranslation(word.word, shown.translation)
  }, [word, shown.translation, vocabMap])
  const addAnyway = async () => {
    if (!lookup || addAnywayBusy) return
    setAddAnywayBusy(true)
    try {
      recordSavedWord(await promoteLookup(lookup.id))
      setLookup(null)
      setToast(t('reader.vocab.addedToSrs'))
      onClose(false)
    } catch {
      setToast(t('reader.vocab.addAnywayFailed'))
    } finally {
      setAddAnywayBusy(false)
    }
  }
  const restore = async () => {
    if (!deleted) return
    setDeleted(null)
    try {
      recordSavedWord(await restoreWord(deleted.id))
      emitDataChange('vocabulary')
    } catch {
      setToast(t('reader.vocab.restoreFailed'))
    }
  }
  const lookupHere = word && lookup?.word === word.word ? lookup : null

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
          isSaved={vocabMap.has(normalizeVocabKey(word.word))}
          lookupInfo={lookupHere && { kind: lookupHere.kind, tapsRemaining: lookupHere.tapsRemaining }}
          onAddAnyway={lookupHere ? () => { void addAnyway() } : undefined}
          addAnywayBusy={addAnywayBusy}
          saveInFlight={saving === word.word}
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
      {vocab.idbUnavailable && (
        <Toast
          message={t('reader.idbUnavailable')}
          duration={5000}
          onClose={vocab.dismissIdbUnavailable}
          onClick={() => { vocab.dismissIdbUnavailable(); openAuthModal() }}
        />
      )}
      {vocab.guestNudge && (
        <Toast
          message={t(vocab.guestNudge === 'ten' ? 'guest.nudgeTen' : 'guest.nudgeThree')}
          duration={6000}
          onClose={vocab.dismissGuestNudge}
          action={{ label: t('guest.nudgeCta'), onClick: () => openAuthModal('register') }}
        />
      )}
      {deleted && (
        <Toast
          message={t('reader.vocab.deletedEarlier', { word: deleted.word })}
          duration={6000}
          onClose={() => setDeleted(null)}
          action={{ label: t('reader.vocab.restore'), onClick: () => { void restore() } }}
        />
      )}
      {toast && <Toast message={toast} duration={3500} onClose={() => setToast(null)} />}
    </>
  )
}
