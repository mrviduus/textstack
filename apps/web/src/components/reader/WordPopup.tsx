import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { SpeakButton } from '../vocabulary/SpeakButton'
import { LANGUAGES, POPULAR_LANGUAGES, OTHER_LANGUAGES, getLanguage, type LanguageEntry } from '@textstack/shared'
import { getFlagUrl } from '../../data/flags'
import { RareWordNotice } from './RareWordNotice'

function LangOption({ lang, onSelect }: { lang: LanguageEntry; onSelect: (code: string) => void }) {
  return (
    <button
      className="word-popup__lang-option"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(lang.code)}
    >
      <img src={getFlagUrl(lang.code)} alt="" width="16" height="12" />
      <span className="word-popup__lang-native">{lang.nativeName}</span>
      {lang.englishName !== lang.nativeName && (
        <span className="word-popup__lang-english">{lang.englishName}</span>
      )}
    </button>
  )
}

const AUTO_DISMISS_MS_MIN = 3000
const AUTO_DISMISS_MS_MAX = 8000
const AUTO_DISMISS_MS_PER_WORD = 350  // L2-reader pace, ~170 wpm
const EXIT_DURATION_MS = 150
// Rare-word notice needs decision time + user may walk away. Long fallback so
// popup can't linger forever (obscuring text underneath), but long enough that
// a slow reader can finish the body + decide.
const LOOKUP_AUTO_DISMISS_MS = 20000

// CJK (Hiragana, Katakana, CJK Unified, Hangul) — spaceless scripts where each
// glyph carries ~word-level info. Counted as individual reading units so
// Chinese/Japanese/Korean translations aren't flattened to 1 word.
const CJK_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g

// Scale dismiss timer to content length so a 16-word definition gets more
// read-time than a 1-word translation. Min 3s (short content), max 8s (don't
// keep popup open forever — user can always tap to extend).
function computeDismissMs(translation: string | null, definition: string | null): number {
  const text = `${translation ?? ''} ${definition ?? ''}`.trim()
  if (!text) return AUTO_DISMISS_MS_MIN
  const cjkChars = (text.match(CJK_RE) || []).length
  const nonCjk = text.replace(CJK_RE, ' ')
  const words = nonCjk.split(/\s+/).filter(Boolean).length
  const units = words + cjkChars
  return Math.min(AUTO_DISMISS_MS_MAX, Math.max(AUTO_DISMISS_MS_MIN, units * AUTO_DISMISS_MS_PER_WORD))
}

interface WordPopupProps {
  word: string
  phonetic?: string
  translation: string | null
  translationLoading: boolean
  definition: string | null
  definitionLoading: boolean
  rect: DOMRect | null
  containerRef: React.RefObject<HTMLElement | null>
  onSpeak: () => void
  onRemove?: () => void
  onClose: () => void
  isSaved: boolean
  nativeLanguage: string
  onChangeNativeLanguage: (code: string) => void
  /**
   * Whether the user has explicitly confirmed their native language. When
   * false, `nativeLanguage` is a `navigator.language` guess — saving vocab
   * with it poisons SRS. Popup auto-expands the language picker and footer
   * reads "Pick your native language to save words" until confirmed.
   */
  hasConfirmedLanguage: boolean
  bookLanguage: string
  t: (key: string, params?: Record<string, string | number>) => string
  // F1 rare-word flow: when SaveWord returns `lookup` / `lookup_pending`, the
  // parent passes lookupInfo so we render the RareWordNotice inline. Null =
  // normal save flow.
  lookupInfo?: { kind: 'lookup' | 'lookup_pending'; tapsRemaining: number | null } | null
  onAddAnyway?: () => void
  addAnywayBusy?: boolean
  // True while auto-save POST is still in flight. Auto-dismiss stays parked
  // until this clears so a slow save can't race the 3-8s timer and close the
  // popup before a lookup outcome arrives.
  saveInFlight?: boolean
}

export function WordPopup({
  word,
  phonetic,
  translation,
  translationLoading,
  definition,
  definitionLoading,
  rect,
  containerRef,
  onSpeak,
  onRemove,
  onClose,
  isSaved,
  nativeLanguage,
  onChangeNativeLanguage,
  hasConfirmedLanguage,
  bookLanguage,
  t,
  lookupInfo,
  onAddAnyway,
  addAnywayBusy,
  saveInFlight,
}: WordPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  // Auto-expand language picker when the user hasn't confirmed native yet,
  // OR when native equals the book language (nothing to translate to — user
  // must pick a real native). Contextual gate: word tap triggers the prompt
  // exactly when native language becomes relevant.
  const [showLangPicker, setShowLangPicker] = useState(
    !hasConfirmedLanguage || nativeLanguage === bookLanguage,
  )
  const [langQuery, setLangQuery] = useState('')
  const [showMoreLangs, setShowMoreLangs] = useState(false)
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const filteredLangs = useMemo(() => {
    const q = langQuery.trim().toLowerCase()
    if (!q) return null
    return LANGUAGES.filter(
      (l) =>
        l.code !== nativeLanguage && l.code !== bookLanguage && (
          l.englishName.toLowerCase().includes(q) ||
          l.nativeName.toLowerCase().includes(q) ||
          l.code.toLowerCase().startsWith(q)
        ),
    )
  }, [langQuery, nativeLanguage, bookLanguage])

  // Use ref-based guard (state lags behind batching → rapid calls leak timers + onClose×N).
  const animatedClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    clearTimeout(dismissTimerRef.current)
    exitTimerRef.current = setTimeout(onClose, EXIT_DURATION_MS)
  }, [onClose])

  // Reset closing state on new word OR new rect (same word re-tapped elsewhere).
  // Cancel any pending exit timer from a previous close — otherwise it fires 150ms
  // later on the NEW popup and unmounts it (re-tap glitch). Keying on rect too
  // catches same-word re-taps during the 150ms close animation.
  useEffect(() => {
    clearTimeout(exitTimerRef.current)
    closingRef.current = false
    setClosing(false)
  }, [word, rect])

  useEffect(() => () => {
    clearTimeout(exitTimerRef.current)
    clearTimeout(dismissTimerRef.current)
  }, [])

  const cancelAutoDismiss = useCallback(() => {
    clearTimeout(dismissTimerRef.current)
  }, [])

  const scheduleAutoDismiss = useCallback(() => {
    clearTimeout(dismissTimerRef.current)
    // Hold the timer while save is in flight — otherwise a slow server response
    // can close the popup before a lookup outcome arrives, and the user never
    // sees RareWordNotice. Timer is re-armed when `saveInFlight` flips false.
    if (saveInFlight) return
    // Rare-word notice: give the user plenty of time to read + decide on
    // "Add anyway", but still bound it — a forgotten popup mustn't obscure
    // text under it indefinitely. Hover/click-in cancels the timer as usual.
    const ms = lookupInfo
      ? LOOKUP_AUTO_DISMISS_MS
      : computeDismissMs(translation, definition)
    dismissTimerRef.current = setTimeout(animatedClose, ms)
  }, [animatedClose, translation, definition, lookupInfo, saveInFlight])

  // Start auto-dismiss timer on open / word change / same-word re-tap at new rect.
  // Keying on rect ensures re-tapping the same word restarts the timer — otherwise
  // the old timer (maybe about to fire) closes the popup right after the user re-engages.
  // Also re-fires when lookupInfo or saveInFlight flip so the timer strategy
  // adapts as async results land (short → 20s for lookup; parked → armed when save done).
  useEffect(() => {
    scheduleAutoDismiss()
    return () => clearTimeout(dismissTimerRef.current)
  }, [word, rect, !!lookupInfo, saveInFlight]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel auto-dismiss when lang picker is open + autofocus search.
  // On close: clear query AND resume auto-dismiss — otherwise toggling the
  // "Change" button to close the picker leaves the popup stuck open forever.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (showLangPicker) {
      cancelAutoDismiss()
      setTimeout(() => searchInputRef.current?.focus(), 0)
    } else {
      setLangQuery('')
      setShowMoreLangs(false)
      if (didMountRef.current) scheduleAutoDismiss()
    }
    didMountRef.current = true
  }, [showLangPicker, cancelAutoDismiss, scheduleAutoDismiss])

  // Restart auto-dismiss when translation finishes loading. Without this, the
  // 3s timer scheduled at popup-open / lang-pick can fire BEFORE a slow
  // translation arrives — user sees the popup vanish just as the result lands.
  // Reset gives them a fresh 3s window from the moment the translation appears.
  // Also covers definition: if dictionary lookup is the slow one, same logic applies.
  const wasLoadingRef = useRef(false)
  useEffect(() => {
    const loading = translationLoading || definitionLoading
    if (wasLoadingRef.current && !loading) {
      scheduleAutoDismiss()
    }
    wasLoadingRef.current = loading
  }, [translationLoading, definitionLoading, scheduleAutoDismiss])

  // Position popup relative to word rect.
  // useLayoutEffect (not useEffect) so repositioning happens synchronously
  // before paint — otherwise content changes (translation arriving, lang picker
  // opening) cause a visible flash at the old position with new dimensions.
  // Skip while closing — re-positioning a fading popup causes visual jitter, especially
  // when async data (translation/definition) arrives mid-exit.
  useLayoutEffect(() => {
    if (closing) return
    if (!rect || !containerRef.current || !popupRef.current) {
      setPosition(null)
      return
    }

    const container = containerRef.current
    const containerRect = container.getBoundingClientRect()
    const popup = popupRef.current
    const popupRect = popup.getBoundingClientRect()

    let top = rect.bottom + 8
    let left = rect.left + rect.width / 2 - popupRect.width / 2

    // Clamp horizontally within container
    const minLeft = containerRect.left + 8
    const maxLeft = containerRect.right - popupRect.width - 8
    left = Math.max(minLeft, Math.min(left, maxLeft))

    // Flip above if no room below
    if (top + popupRect.height > window.innerHeight - 8) {
      top = rect.top - popupRect.height - 8
    }

    top = Math.max(8, Math.min(top, window.innerHeight - popupRect.height - 8))

    setPosition({ top, left })
  }, [rect, containerRef, translation, definition, translationLoading, definitionLoading, showLangPicker, closing])

  // Close on click outside.
  // Use pointerdown + drag threshold instead of mousedown — on touch devices a
  // scroll gesture starts with pointerdown but shouldn't dismiss the popup.
  // We only close if the pointer released within ~8px of where it started (real tap).
  useEffect(() => {
    let startX = 0
    let startY = 0
    let startedOutside = false

    const handleDown = (e: PointerEvent) => {
      if (!popupRef.current) return
      if (popupRef.current.contains(e.target as Node)) {
        startedOutside = false
        return
      }
      startedOutside = true
      startX = e.clientX
      startY = e.clientY
    }
    const handleUp = (e: PointerEvent) => {
      if (!startedOutside) return
      startedOutside = false
      const dx = Math.abs(e.clientX - startX)
      const dy = Math.abs(e.clientY - startY)
      if (dx < 8 && dy < 8) animatedClose()
    }
    document.addEventListener('pointerdown', handleDown)
    document.addEventListener('pointerup', handleUp)
    return () => {
      document.removeEventListener('pointerdown', handleDown)
      document.removeEventListener('pointerup', handleUp)
    }
  }, [animatedClose])

  // Close on Escape — but if lang picker is open, close that first. Native
  // listeners run regardless of React's preventDefault on synthetic events,
  // so the picker's input handler alone can't stop the popup from closing.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (showLangPicker) {
        setShowLangPicker(false)
      } else {
        animatedClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [animatedClose, showLangPicker])

  // Trap Tab inside popup — only when focus is already within it (don't hijack reader nav).
  // Once user tabs into popup (or picker autofocuses search), Tab cycles within.
  useEffect(() => {
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const popup = popupRef.current
      const active = document.activeElement as HTMLElement | null
      if (!popup || !active || !popup.contains(active)) return
      const focusables = popup.querySelectorAll<HTMLElement>(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleTab)
    return () => document.removeEventListener('keydown', handleTab)
  }, [showLangPicker]) // re-bind so focusable list refreshes when picker toggles

  // setShowLangPicker(false) → showLangPicker effect reschedules auto-dismiss; no manual call needed.
  const selectLang = useCallback((code: string) => {
    onChangeNativeLanguage(code)
    setShowLangPicker(false)
  }, [onChangeNativeLanguage])

  if (!rect) return null

  const langLabel = getLanguage(nativeLanguage)?.nativeName || nativeLanguage
  // Three footer states:
  //   needsNativeLang: user hasn't confirmed → prompt + expanded picker, no "Change" btn.
  //   isDefinitionMode: confirmed but same-lang as book → explain *why* no translation.
  //   default: confirmed different → show target native + "Change".
  const needsNativeLang = !hasConfirmedLanguage
  const isDefinitionMode = hasConfirmedLanguage && nativeLanguage === bookLanguage
  const footerLabel = needsNativeLang
    ? t('reader.wordPopup.needsNativeLang')
    : isDefinitionMode
      ? t('reader.wordPopup.definitionModeHint')
      : `${t('reader.wordPopup.translatingTo')} ${langLabel}`
  const changeLabel = isDefinitionMode
    ? t('reader.wordPopup.translateTo')
    : t('reader.wordPopup.change')

  // Conditional preventDefault: protect reader selection (mousedown on any
  // non-input area moves selection anchor and collapses it → bubble dies).
  // Skip for inputs/textareas so they keep native focus without per-child
  // stopPropagation (the earlier "all children must remember to preventDefault"
  // pattern was fragile — easy to break when adding a new text div).
  const preventSelectionLoss = (e: React.MouseEvent | React.TouchEvent) => {
    const t = e.target as HTMLElement
    if (t.matches('input, textarea, [contenteditable="true"]')) return
    e.preventDefault()
  }
  return (
    <div
      ref={popupRef}
      className={`word-popup${closing ? ' word-popup--closing' : ''}`}
      style={{
        position: 'fixed',
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseDown={preventSelectionLoss}
      onTouchStart={preventSelectionLoss}
      onMouseEnter={cancelAutoDismiss}
      onPointerEnter={cancelAutoDismiss}
      onClick={cancelAutoDismiss}
      onFocus={cancelAutoDismiss}
    >
      <div className="word-popup__header">
        <span className="word-popup__word">{word}</span>
        {phonetic && (
          <span className="word-popup__phonetic">{phonetic}</span>
        )}
        <button
          className="word-popup__close"
          onClick={animatedClose}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t('reader.wordPopup.close')}
        >
          ×
        </button>
      </div>

      {/* Translation - primary content. Skip entirely in same-language mode
         (translation null + not loading) to avoid empty div with CSS padding. */}
      {(translationLoading || translation) && (
        <div className="word-popup__translation">
          {translationLoading ? (
            <span className="word-popup__loading">{t('reader.wordPopup.loading')}</span>
          ) : (
            translation
          )}
        </div>
      )}

      {/* Definition - secondary, async */}
      {(definitionLoading || definition) && (
        <div className="word-popup__definition">
          {definitionLoading ? (
            <span className="word-popup__loading">{t('reader.wordPopup.loading')}</span>
          ) : (
            definition
          )}
        </div>
      )}

      <div className="word-popup__actions">
        <SpeakButton onClick={onSpeak} size={16} />
        {isSaved && (
          <span className="word-popup__saved-status" aria-live="polite">
            <span className="material-icons-outlined" aria-hidden="true">check</span>
            {t('reader.wordPopup.savedStatus')}
          </span>
        )}
        {isSaved && onRemove && (
          <button
            className="word-popup__btn word-popup__btn--remove"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onRemove}
            aria-label={t('reader.wordPopup.ignore')}
          >
            <span className="material-icons-outlined word-popup__btn-icon" aria-hidden="true">delete_outline</span>
            {t('reader.wordPopup.ignore')}
          </button>
        )}
      </div>

      {lookupInfo && onAddAnyway && (
        <RareWordNotice
          kind={lookupInfo.kind}
          tapsRemaining={lookupInfo.tapsRemaining}
          busy={addAnywayBusy ?? false}
          onAddAnyway={onAddAnyway}
          t={t}
        />
      )}

      {/* Language footer */}
      <div className="word-popup__lang-footer">
        <span className="word-popup__lang-label">{footerLabel}</span>
        {/* Hide "Change" when user hasn't confirmed native yet — the picker
            is already forced open and closing it would leave them staring at
            a prompt with no way to act. After first pick, button re-appears. */}
        {!needsNativeLang && (
          <button
            className="word-popup__lang-change"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowLangPicker(!showLangPicker)}
          >
            {changeLabel}
          </button>
        )}
        {showLangPicker && (
          <div className="word-popup__lang-dropdown">
            <input
              ref={searchInputRef}
              type="text"
              value={langQuery}
              onChange={(e) => setLangQuery(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setShowLangPicker(false) // showLangPicker effect reschedules
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  // Enter selects only when the query unambiguously points at the first
                  // result — either the only match, or first match's code/name STARTS WITH
                  // the query. Otherwise a substring hit could silently swap the user's
                  // native language to something they didn't mean (e.g. "en" → Slovenian).
                  if (!filteredLangs || filteredLangs.length === 0) return
                  const q = langQuery.trim().toLowerCase()
                  const first = filteredLangs[0]
                  const startsWith =
                    first.code.toLowerCase().startsWith(q) ||
                    first.englishName.toLowerCase().startsWith(q) ||
                    first.nativeName.toLowerCase().startsWith(q)
                  if (filteredLangs.length === 1 || startsWith) {
                    selectLang(first.code)
                  }
                }
              }}
              placeholder={t('reader.wordPopup.searchLanguage') || 'Search language...'}
              className="word-popup__lang-search"
              autoComplete="off"
            />
            <div className="word-popup__lang-list">
              {filteredLangs ? (
                filteredLangs.length === 0 ? (
                  <div className="word-popup__lang-empty">{t('reader.wordPopup.noResults') || 'No results'}</div>
                ) : (
                  filteredLangs.map((l) => (
                    <LangOption key={l.code} lang={l} onSelect={selectLang} />
                  ))
                )
              ) : (
                <>
                  <div className="word-popup__lang-section">{t('reader.wordPopup.popularLanguages')}</div>
                  {POPULAR_LANGUAGES.filter(l => l.code !== nativeLanguage && l.code !== bookLanguage).map((l) => (
                    <LangOption key={l.code} lang={l} onSelect={selectLang} />
                  ))}
                  {showMoreLangs ? (
                    <>
                      <div className="word-popup__lang-section">{t('reader.wordPopup.allLanguages')}</div>
                      {OTHER_LANGUAGES.filter(l => l.code !== nativeLanguage && l.code !== bookLanguage).map((l) => (
                        <LangOption key={l.code} lang={l} onSelect={selectLang} />
                      ))}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="word-popup__lang-more"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setShowMoreLangs(true)}
                    >
                      {t('reader.wordPopup.moreLanguages')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
