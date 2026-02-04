import { useRef, useCallback, useState } from 'react'
import { useTextSelection } from '../../hooks/useTextSelection'
import { useHighlights } from '../../hooks/useHighlights'
import { useTextTranslation } from '../../hooks/useTextTranslation'
import { useDictionary } from '../../hooks/useDictionary'
import { createTextAnchor } from '../../lib/textAnchor'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { SelectionToolbar } from './SelectionToolbar'
import { HighlightLayer } from './HighlightLayer'
import { TranslationPopup } from './TranslationPopup'
import { DictionaryPopup } from './DictionaryPopup'
import { NoteEditor } from './NoteEditor'

interface ReaderHighlightsProps {
  editionId: string
  chapterId: string
  containerRef: React.RefObject<HTMLElement | null>
  isAuthenticated?: boolean
  bookLanguage?: string
  children: React.ReactNode
}

export function ReaderHighlights({
  editionId,
  chapterId,
  containerRef,
  isAuthenticated,
  bookLanguage = 'en',
  children,
}: ReaderHighlightsProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [showTranslation, setShowTranslation] = useState(false)
  const [translationText, setTranslationText] = useState('')
  const [translationRect, setTranslationRect] = useState<DOMRect | null>(null)
  const [showDictionary, setShowDictionary] = useState(false)
  const [dictionaryWord, setDictionaryWord] = useState('')
  const [dictionaryRect, setDictionaryRect] = useState<DOMRect | null>(null)
  const [editingHighlight, setEditingHighlight] = useState<StoredHighlight | null>(null)
  const [editingHighlightRect, setEditingHighlightRect] = useState<DOMRect | null>(null)

  // Use the container ref for selection detection
  const { selection, clearSelection, hasSelection } = useTextSelection(containerRef)

  // Highlights for current chapter
  const {
    highlights,
    addHighlight,
    updateHighlight,
    removeHighlight,
  } = useHighlights(editionId, {
    chapterId,
    isAuthenticated,
  })

  // Translation
  const {
    translatedText,
    isLoading: isTranslating,
    error: translationError,
    translate,
    reset: resetTranslation,
    languages,
    sourceLang,
    targetLang,
    setSourceLang,
    setTargetLang,
  } = useTextTranslation({
    defaultSourceLang: bookLanguage,
    defaultTargetLang: bookLanguage === 'uk' ? 'en' : 'uk',
  })

  // Dictionary
  const {
    entry: dictionaryEntry,
    isLoading: isDictionaryLoading,
    error: dictionaryError,
    lookup: lookupWord,
    reset: resetDictionary,
  } = useDictionary()

  const handleHighlight = useCallback(
    async (color: HighlightColor) => {
      if (!selection.range || !containerRef.current) return

      const anchor = createTextAnchor(selection.range, chapterId, containerRef.current)
      await addHighlight(anchor, color, selection.text)
      clearSelection()
      setShowTranslation(false)
    },
    [selection, containerRef, chapterId, addHighlight, clearSelection]
  )

  const handleTranslate = useCallback(() => {
    if (!selection.text || !selection.rect) return

    // Limit to 500 characters
    const textToTranslate = selection.text.slice(0, 500)
    setTranslationText(textToTranslate)
    setTranslationRect(selection.rect)
    setShowTranslation(true)
    translate(textToTranslate)
  }, [selection, translate])

  const handleCloseTranslation = useCallback(() => {
    setShowTranslation(false)
    setTranslationText('')
    setTranslationRect(null)
    resetTranslation()
    clearSelection()
  }, [resetTranslation, clearSelection])

  const handleSourceLangChange = useCallback(
    (lang: string) => {
      setSourceLang(lang)
      if (translationText) {
        translate(translationText, lang, targetLang)
      }
    },
    [setSourceLang, translate, translationText, targetLang]
  )

  const handleTargetLangChange = useCallback(
    (lang: string) => {
      setTargetLang(lang)
      if (translationText) {
        translate(translationText, sourceLang, lang)
      }
    },
    [setTargetLang, translate, translationText, sourceLang]
  )

  const handleDictionary = useCallback(() => {
    if (!selection.text || !selection.rect) return

    const word = selection.text.trim()
    setDictionaryWord(word)
    setDictionaryRect(selection.rect)
    setShowDictionary(true)
    lookupWord(word, bookLanguage)
  }, [selection, lookupWord, bookLanguage])

  const handleCloseDictionary = useCallback(() => {
    setShowDictionary(false)
    setDictionaryWord('')
    setDictionaryRect(null)
    resetDictionary()
    clearSelection()
  }, [resetDictionary, clearSelection])

  const handleCopy = useCallback(() => {
    clearSelection()
    setShowTranslation(false)
    setShowDictionary(false)
  }, [clearSelection])

  const handleHighlightClick = useCallback(
    (highlight: StoredHighlight, rect: DOMRect) => {
      setEditingHighlight(highlight)
      setEditingHighlightRect(rect)
    },
    []
  )

  const handleNoteEditorClose = useCallback(() => {
    setEditingHighlight(null)
    setEditingHighlightRect(null)
  }, [])

  const handleNoteSave = useCallback(
    async (noteText: string | null) => {
      if (!editingHighlight) return
      await updateHighlight(editingHighlight.id, { noteText })
    },
    [editingHighlight, updateHighlight]
  )

  const handleHighlightDelete = useCallback(async () => {
    if (!editingHighlight) return
    await removeHighlight(editingHighlight.id)
    setEditingHighlight(null)
    setEditingHighlightRect(null)
  }, [editingHighlight, removeHighlight])

  return (
    <div ref={wrapperRef} className="reader-highlights-wrapper">
      {children}

      <HighlightLayer
        highlights={highlights}
        containerRef={containerRef}
        onHighlightClick={handleHighlightClick}
      />

      {hasSelection && !showTranslation && !showDictionary && (
        <SelectionToolbar
          rect={selection.rect}
          text={selection.text}
          containerRef={containerRef}
          onHighlight={handleHighlight}
          onTranslate={handleTranslate}
          onDictionary={handleDictionary}
          onCopy={handleCopy}
        />
      )}

      {showTranslation && (
        <TranslationPopup
          text={translationText}
          translatedText={translatedText}
          isLoading={isTranslating}
          error={translationError}
          sourceLang={sourceLang}
          targetLang={targetLang}
          languages={languages}
          rect={translationRect}
          containerRef={containerRef}
          onSourceLangChange={handleSourceLangChange}
          onTargetLangChange={handleTargetLangChange}
          onClose={handleCloseTranslation}
        />
      )}

      {showDictionary && (
        <DictionaryPopup
          word={dictionaryWord}
          entry={dictionaryEntry}
          isLoading={isDictionaryLoading}
          error={dictionaryError}
          rect={dictionaryRect}
          containerRef={containerRef}
          onClose={handleCloseDictionary}
        />
      )}

      {editingHighlight && (
        <NoteEditor
          highlight={editingHighlight}
          rect={editingHighlightRect}
          containerRef={containerRef}
          onSave={handleNoteSave}
          onDelete={handleHighlightDelete}
          onClose={handleNoteEditorClose}
        />
      )}
    </div>
  )
}
