import { useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import { t, type Language } from '@textstack/shared'
import type { Chapter } from '@textstack/shared'
import type { useRouter } from 'expo-router'
import type { useAuth } from '../../context/AuthContext'
import type { useToast } from '../../context/ToastContext'
import type { useReaderSettings } from '../../hooks/useReaderSettings'
import type { useHaptics } from '../../hooks/useHaptics'
import type { useReaderExitSummary } from '../../hooks/useReaderExitSummary'
import { useReaderHighlights } from '../../hooks/useReaderHighlights'
import { useReaderVocabMap } from '../../hooks/useReaderVocabMap'
import { useReaderVocabActions } from '../../hooks/useReaderVocabActions'
import { useReaderSelection } from '../../hooks/useReaderSelection'
import { saveWordIntent } from '../../lib/saveWordIntent'
import { capabilitiesFor } from '../../lib/capabilities'
import { claimGuestNudge } from '../../lib/guestNudge'
import type { ReaderShellProps } from './readerShellTypes'

/** Lightweight {key} interpolation — shared `t()` returns raw keys, we fill them in here. */
function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}

type Args = Pick<ReaderShellProps, 'source' | 'injectJs' | 'bookTitleRef' | 'original'> & {
  chapter: { id: string }
  user: ReturnType<typeof useAuth>['user']
  isAuthenticated: boolean
  language: Language
  textLanguage: string
  nativeLanguage: string
  settings: ReturnType<typeof useReaderSettings>['settings']
  updateSettings: ReturnType<typeof useReaderSettings>['update']
  haptics: ReturnType<typeof useHaptics>
  showToast: ReturnType<typeof useToast>['show']
  router: ReturnType<typeof useRouter>
  sessionWordCountRef: MutableRefObject<number>
  setSessionWordCount: ReturnType<typeof useReaderExitSummary>['setSessionWordCount']
  footerHeight: number
}

/**
 * The selection toolbar and word card's actions: vocab underline, selection state, highlights,
 * save / known / remove a word, highlight a selection (reflow or the Original PDF).
 */
export function useReaderWordActions({
  source, injectJs, bookTitleRef, original, chapter, user, isAuthenticated,
  language, textLanguage, nativeLanguage, settings, updateSettings, haptics, showToast, router,
  sessionWordCountRef, setSessionWordCount, footerHeight,
}: Args) {
  const { vocabMapRef, flushToCache: flushVocabMap, bumpVocab } = useReaderVocabMap({
    user,
    isAuthenticated,
    chapterId: chapter.id,
    injectJs,
    bookLanguage: textLanguage,
    nativeLanguage,
  })

  const {
    selection,
    setSelection,
    wordSaved,
    lookupState,
    setLookupState,
    setWordSaved,
    openSelection,
  } = useReaderSelection({ flushVocabMap })

  const {
    highlightsRef,
    editingHighlight,
    setEditingHighlight,
    create: createHighlight,
    createPdf: createPdfHighlight,
    repaintPdf,
    saveNote: saveHighlightNote,
    updateColor: updateHighlightColor,
    remove: removeHighlight,
  } = useReaderHighlights({
    ...(source.kind === 'edition'
      ? { editionId: source.id, editionIdRef: source.idRef }
      : { userBookId: source.id, userBookIdRef: source.idRef }),
    user,
    isAuthenticated,
    chapterId: chapter.id,
    injectJs,
    showToast,
    original,
  })

  // Original PDF: the color the user picked in the toolbar, held while the
  // bundled viewer resolves the anchor for the current selection and posts
  // `pdfHighlightCreate` back. Read by the message handler at persist time.
  const pendingPdfColorRef = useRef<string>(settings.lastHighlightColor)

  const isGuest = capabilitiesFor(user).isGuest
  const notifyWordSaved = useCallback(() => {
    sessionWordCountRef.current += 1
    const count = sessionWordCountRef.current
    haptics.play('complete')
    const savedToast = () => showToast({
      variant: 'success',
      message:
        count > 1
          ? interpolate(t(language, 'reader.toastWordAddedCount'), { count })
          : t(language, 'reader.toastWordAdded'),
      actionLabel: t(language, 'reader.toastTapToReview'),
      onPress: () => router.push('/vocabulary'),
      duration: 2400,
    })
    if (!isGuest) { savedToast(); return }
    // A guest's 3rd and 10th word: the "keep them" nudge replaces the saved
    // toast, once each per install (`guestNudge.ts`). The count is the reader's
    // whole vocabulary — `vocabMapRef` is loaded from `getReaderVocab()` (every
    // saved word) and `onWordSaved` has already added this one — not the
    // session's. Login opens as a modal over the reader; `then: 'back'` makes it
    // dismiss back here instead of landing on Library.
    void claimGuestNudge(true, Object.keys(vocabMapRef.current).length).then(nudge => {
      if (!nudge) { savedToast(); return }
      showToast({
        variant: 'success',
        message: t(language, nudge === 'ten' ? 'guest.nudgeTen' : 'guest.nudgeThree'),
        actionLabel: t(language, 'guest.nudgeCta'),
        onPress: () => router.push({ pathname: '/(auth)/login', params: { mode: 'register', then: 'back' } }),
        duration: 6000,
      })
    })
  }, [haptics, showToast, language, router, isGuest, vocabMapRef])

  const vocabActions = useReaderVocabActions({
    vocabMapRef,
    bookTitleRef,
    ...(source.kind === 'edition' ? { editionIdRef: source.idRef } : { userBookIdRef: source.idRef }),
    chapter: { id: chapter.id } as unknown as Chapter,
    language,
    textLanguage,
    nativeLanguage,
    isAuthenticated,
    injectJs,
    bumpVocab,
    notifyWordSaved,
    setSessionWordCount,
    setWordSaved,
    setSelection,
    setLookupState,
    showToast,
  })

  // The word toolbar's close — its X button and Android back (M3).
  const closeSelection = useCallback(() => {
    injectJs('try{window.getSelection&&window.getSelection().removeAllRanges()}catch(e){};try{window.__tsClearWordMark&&window.__tsClearWordMark()}catch(e){}')
    setSelection(null)
  }, [injectJs, setSelection])

  // Save is now on screen for guests too (SelectionActionBar), so this handler owns
  // the answer for them — and the answer stays in the book. No action, no router:
  // the toast says what happened and dismisses.
  //
  // It used to carry a "Sign in" CTA that pushed `/(auth)/login`, and that was the
  // worse of the two bugs the dead button had. `ToastContext` makes the WHOLE toast
  // pressable (`onPress={current.onPress ?? hide}`), so a guest who merely swatted
  // the toast away was ejected too; and sign-in ends in `router.replace('/(tabs)/library')`
  // (deliberate, see the comment block in `app/(auth)/login.tsx`), which tears the
  // reader stack down — the guest did not come back to their page, they landed on
  // the Library tab. Nothing here may take a reader out of their book.
  //
  // The word itself is not rescued: web queues it (`useReaderVocabulary`'s pending
  // list) and mobile has no such store, so the copy admits the word was not kept
  // rather than promising otherwise. Deliberately no pending queue and no sheet on
  // top of this — the next PR mints guest sessions, a guest saves for real, and this
  // whole branch goes away.
  //
  // `bottomOffset: footerHeight` clears the reader footer. `notifyWordSaved` above
  // passes no offset and so takes the provider's tab-bar-sized default; these two
  // toasts do NOT have the same shape, and this one is not trying to.
  //
  // Decided by `saveWordIntent` rather than inline, so the rule is covered by the
  // only test lane this app has; the `!isAuthenticated` early return still inside
  // useReaderVocabActions stays as defence in depth.
  const handleSaveWord = () => {
    const intent = saveWordIntent({ isAuthenticated, hasSelection: !!selection })
    if (intent === 'prompt') {
      haptics.play('flip')
      showToast({
        variant: 'info',
        message: t(language, 'reader.vocab.saveNeedsAccount'),
        // Longer than the success toasts: it is two clauses, and a reader who is
        // mid-sentence is not looking straight at it.
        duration: 3600,
        bottomOffset: footerHeight,
      })
      return
    }
    if (intent === 'ignore') return
    return vocabActions.saveWord(selection!)
  }
  const handleMarkKnown = () => selection ? vocabActions.markKnown(selection) : undefined
  const handleRemoveWord = () => selection ? vocabActions.removeWord(selection) : undefined

  const handleHighlight = useCallback(async (color: string) => {
    if (!selection) return
    if (color === 'yellow' || color === 'green' || color === 'pink' || color === 'blue') {
      updateSettings({ lastHighlightColor: color })
    }
    // Original PDF: RN can't reach the WebView's DOM Range, so the bundled
    // viewer resolves the quad-rect anchor from the live selection and posts
    // `pdfHighlightCreate` back (mirrors web computePdfAnchorFromRange at commit
    // time). Stash the color; the message handler persists with it.
    if (original) {
      pendingPdfColorRef.current = color
      injectJs('window.__pdfCreateHighlight && window.__pdfCreateHighlight()')
      setSelection(null)
      return
    }
    await createHighlight({ color, selection, chapter: { id: chapter.id } })
    setSelection(null)
  }, [selection, chapter.id, createHighlight, updateSettings, original, injectJs])

  return {
    vocabMapRef, vocabActions,
    selection, wordSaved, lookupState, openSelection, closeSelection,
    highlightsRef, editingHighlight, setEditingHighlight, createPdfHighlight, repaintPdf,
    saveHighlightNote, updateHighlightColor, removeHighlight, pendingPdfColorRef,
    handleSaveWord, handleMarkKnown, handleRemoveWord, handleHighlight,
  }
}
