import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react'
import type { V2Popup } from '../../../../../packages/reader/src/wordPopup.mjs'
import type { V2Rect } from '../../../../../packages/reader/src/selection.mjs'
import { saveOutcome } from '../../../../../packages/reader/src/vocabSave.mjs'
import { useNativeLanguage } from '../../context/NativeLanguageContext'
import { useAuth } from '../../context/AuthContext'
import { useV2ReaderVocabulary } from '../../hooks/useV2ReaderVocabulary'
import { restoreWord } from '../../api/vocabulary'
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
import { PdfHighlightPopup } from './PdfHighlightPopup'
import type { V2HighlightColor, V2HighlightItem } from '../../../../../packages/reader/src/highlights.mjs'
import type { V2MarkWord } from '../../../../../packages/reader/src/wordMarks.mjs'
import { markWordsOf } from '../../../../../packages/reader/src/vocabWords.mjs'
import { createListener, spokenOf } from '../../../../../packages/reader/src/listen.mjs'
import { useTts } from '../../hooks/useTts'

/** #1312: the highlight a tap opened (`popup.kind === 'highlight'`), as the host knows it, and what its editor does. */
export interface V2HighlightEditor {
  item: V2HighlightItem
  /** The host's note (the page holds none); null: none. */
  note: string | null
  onRecolor: (color: V2HighlightColor) => void
  /** The draft as typed, Save's and Cancel's included (null: Delete, nothing to write): the host writes a changed one whatever closes the editor. */
  onDraft: (draft: { text: string; from: string | null } | null) => void
  onDelete: () => void
}

interface Props {
  /** What is open (wordPopup.mjs `popupStep`, run by the host on the page's messages). */
  popup: V2Popup | null
  /** The reader frame: the page's rects are in its viewport. */
  frame: RefObject<HTMLIFrameElement | null>
  /** `opened.lang` through readLang, else `en` (the legacy reader's default). */
  bookLanguage: string
  /** #1271: the language whose saved words are marked and filled (savesWords' rule); null: none (a language that does not read). */
  marksLanguage?: string | null
  /** The server book on screen (the production route): a tapped word is saved to the vocabulary with it. None: nothing is saved (the dev route). */
  bookId?: string
  /** Its title as the page read it (untrusted: React text, and the example's `bookTitle`, clipped by the save). */
  bookTitle?: string
  /** The toolbar's Highlight in the colour chosen; absent where the host offers none (an image or PDF book, the server's highlights not in yet). */
  onHighlight?: (color: V2HighlightColor) => void
  /** #1312: the editor of the highlight tapped, when the host knows it. */
  highlight?: V2HighlightEditor | null
  /**
   * #1271: the reader's saved words as the page marks them, each time they change (loaded, saved, a translation
   * backfilled): `useReaderVocabulary` reads them once per mount, keeps them in memory and fills missing translations once.
   */
  onMarks?: (words: V2MarkWord[]) => void
  /** The word popup or the toolbar closed (`selectionDone` false), or the selection's actions are done (true): the page's selection goes, and the toolbar if it is still what is open (never a newer word popup). */
  onClose: (selectionDone: boolean) => void
  /** #1272: the language the book is spoken in (listen.mjs `ttsLang`); null: no Listen (Ukrainian, no language). */
  lang?: string | null
  /** The chosen speed (listen.mjs `TTS_SPEEDS`). */
  ttsSpeed?: number
  /** The range spoken (the page underlines it, `speaking`), null when the speech ended or stopped. */
  onSpoken?: (range: { cfi: string; index: number } | null) => void
}

/**
 * The V2 reader's word popup, selection toolbar, translation popup and streamed explain on the web (#1269): the
 * legacy reader's components and hooks, fetched here by the host (the page has no network). Listen (#1272): the
 * popup's speaker and the toolbar's Listen, the legacy `useTts`, the page marking the range spoken. A tapped word is saved to the
 * vocabulary as the legacy reader saves it (#1270): `useReaderVocabulary` (guests' words, the session minted on the
 * third, nudges at 3 and 10), the outcomes through vocabSave.mjs.
 */
export function V2ReaderPopups({ popup, frame, bookLanguage, marksLanguage = bookLanguage, bookId, bookTitle, onHighlight, highlight, onMarks, onClose, lang = null, ttsSpeed = 1, onSpoken }: Props) {
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
  const vocab = useV2ReaderVocabulary(marksLanguage, targetLang)
  const { vocabMap, addWord, updateTranslation, recordSavedWord, loaded, loadFailed, retryLoad } = vocab
  useEffect(() => {
    onMarks?.(markWordsOf([...vocabMap].map(([word, v]) => ({ word, stage: v.stage, translation: v.translation }))))
  }, [vocabMap])
  const tried = useRef(new Set<string>())
  const [saving, setSaving] = useState<string | null>(null)
  const [deleted, setDeleted] = useState<{ id: string; word: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!word || !bookId || !hasConfirmedLanguage) return
    // Not before the reader's words are in (a word already saved would get another example): a tap while they load
    // saves when they land; after a failed load, a tap retries the load rather than saving blind.
    if (!loaded) {
      if (loadFailed) retryLoad()
      return
    }
    const key = normalizeVocabKey(word.word)
    // Already a card of the reader's (any language, the legacy list's too): never saved twice.
    if (vocab.isKnown(word.word) || tried.current.has(key)) return
    tried.current.add(key)
    setSaving(word.word)
    addWord({
      word: word.word, language: bookLanguage, userBookId: bookId, sentence: word.sentence || undefined,
      bookTitle: bookTitle || undefined, nativeLanguage, translation: fetched.for === request ? fetched.translation ?? null : null,
    }).then((resp) => {
      // Nothing came of it (nothing sent: the identity changed meanwhile; or queued for a guest-to-be, whose word the map
      // now holds): the key is not spent, so a later tap of this word can still save it.
      if (resp === null) tried.current.delete(key)
      const o = saveOutcome(resp)
      if (o.kind === 'deleted') setDeleted({ id: o.id, word: word.word })
    }, () => { tried.current.delete(key) })
      .finally(() => setSaving((s) => (s === word.word ? null : s)))
  }, [word, bookId, hasConfirmedLanguage, loaded])
  // The translation follows the save (TR-2: it fills an untranslated word, never replaces one), in the language the
  // popup opened in: one switched to mid-popup is display-only, as in the legacy reader. A language picked in the
  // footer (the first confirmed one) is the popup's own, not a switch.
  const openedLang = useMemo(() => targetLang, [word, hasConfirmedLanguage])
  useEffect(() => {
    if (word && shown.translation && !shown.failed && targetLang === openedLang) updateTranslation(word.word, shown.translation)
  }, [word, shown.translation, vocabMap])
  const restore = async () => {
    if (!deleted) return
    setDeleted(null)
    try {
      const asked = vocab.identity()
      recordSavedWord(await restoreWord(deleted.id), asked)
      emitDataChange('vocabulary')
    } catch {
      setToast(t('reader.vocab.restoreFailed'))
    }
  }
  /** The tapped word's card id (this book's language), for the popup's Remove; none: no Remove. */
  const removable = word ? vocabMap.get(normalizeVocabKey(word.word))?.id : undefined

  // #1272: Listen, a word or a selection, played here (the page has no network); the page marks the range while it is
  // fetched and played. listen.mjs `createListener` owns the phase (one rule for both hosts); this renders it. No word
  // timestamps (their request takes the same rate-limit permits, and nothing here tracks words). Unmounting (a new open)
  // stops it.
  const tts = useTts()
  const ttsRef = useRef({ tts, lang, ttsSpeed, onSpoken })
  ttsRef.current = { tts, lang, ttsSpeed, onSpoken }
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [listener] = useState(() => createListener({
    speak: (text, done) => {
      const { tts: x, lang: l, ttsSpeed: speed } = ttsRef.current
      return l ? x.speak(text, l, speed, { timestamps: false, onEnd: done }) : false
    },
    stop: () => ttsRef.current.tts.stop(),
    mark: (at) => ttsRef.current.onSpoken?.(at?.cfi ? { cfi: at.cfi, index: at.index } : null),
    changed: rerender,
    failed: () => setToast(t('reader.listenFailed')),
  }))
  useEffect(() => () => listener.stop(), [])
  // The word popup or toolbar that started a Listen closed (or another opened): its speech stops, its mark goes.
  useEffect(() => {
    listener.follow(spokenOf(popup))
  }, [popup])
  // What Listen speaks for what is open (the popup or the toolbar: one at a time).
  const spoken = spokenOf(popup)

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
          isSaved={vocab.isKnown(word.word)}
          onRemove={removable ? () => {
            // A word saved by a stray tap goes again; a later tap saves it anew (the legacy reader's rule).
            void vocab.removeWord(removable, word.word).catch(() => setToast(t('reader.vocab.removeFailed')))
            tried.current.delete(normalizeVocabKey(word.word))
            onClose(false)
          } : undefined}
          saveInFlight={saving === word.word}
          nativeLanguage={nativeLanguage}
          onChangeNativeLanguage={setNativeLanguage}
          hasConfirmedLanguage={hasConfirmedLanguage}
          bookLanguage={bookLanguage}
          onSpeak={lang ? () => listener.press(spoken) : undefined}
          speakState={listener.state(spoken)}
          t={t}
        />
      )}
      {selection && !translationPopup.show && !explainPopup.show && (
        <SelectionToolbar
          rect={rect}
          text={selection.text}
          containerRef={frame}
          hideHighlight={!onHighlight}
          onHighlight={(color) => { onHighlight?.(color); onClose(false) }}
          onTranslate={() => translationPopup.open(selection.text, rect, { sentence: selection.sentence })}
          onExplain={() => explainPopup.openFromSelection(selection.text, rect, selection.sentence)}
          onCopy={() => onClose(true)}
          onSpeak={lang ? () => listener.press(spoken) : undefined}
          speakState={listener.state(spoken)}
          tooLong={selection.tooLong}
        />
      )}
      {popup?.kind === 'highlight' && highlight?.item.id === popup.id && (
        // Keyed: its note field starts from the highlight's note, once.
        <PdfHighlightPopup
          key={popup.id}
          highlight={{ id: popup.id, color: highlight.item.color, selectedText: highlight.item.text, noteText: highlight.note ?? undefined }}
          rect={rect}
          containerRef={frame}
          onRecolor={highlight.onRecolor}
          onDelete={() => { highlight.onDelete(); onClose(false) }}
          onClose={() => onClose(false)}
          onDraft={highlight.onDraft}
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
