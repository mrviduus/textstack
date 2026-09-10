import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { cachedTranslate, peekTranslation, type SaveCategory } from '../lib/translateCache'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useTargetLanguage } from '../hooks/useTargetLanguage'
import { useNeedsNativeLanguage } from '../hooks/useNeedsNativeLanguage'
import { fonts } from '../theme/typography'

const STAGE_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'New', color: '#3b82f6' },
  1: { label: '★1', color: '#eab308' },
  2: { label: '★2', color: '#eab308' },
  3: { label: '★3', color: '#22c55e' },
  4: { label: '✓', color: '#22c55e' },
}

const HIGHLIGHT_FILLS: Record<string, string> = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  pink: '#fbcfe8',
  blue: '#bfdbfe',
}

export type HighlightColorKey = 'yellow' | 'green' | 'pink' | 'blue'

interface SelectionActionBarProps {
  selectedText: string
  isMultiWord: boolean
  /** Source language code — used for fetching the inline translation
   *  when a single word is tapped. Same value the reader passes to TTS. */
  language?: string
  onTranslate: () => void
  onExplain?: () => void
  onSpeak: () => void
  onSaveWord: () => void
  onHighlight?: (color: HighlightColorKey) => void
  /** Last color the user picked — used as the single highlight button's
   *  fill. Tapping commits this color; change via HighlightNoteModal after. */
  highlightColor?: HighlightColorKey
  onMarkKnown?: () => void
  /** Remove the word from vocabulary — lets the user undo an accidental save. */
  onRemove?: () => void
  /** "Ask about this" — opens the Book Chat with the selection attached as a quoted passage
   *  (persistent chat, AI-027). Only wired when the reader has an ask target; shown for
   *  multi-word passages (a single quoted word is redundant with the vocab actions). */
  /** Selection is past the 500-character ceiling the speech and translation
   *  endpoints enforce. Those two and Explain are disabled; Copy, Highlight
   *  and Ask still work, which is why the toolbar opens at all. */
  tooLong?: boolean
  isSpeaking?: boolean
  /** Audio is being fetched — there is no sound yet. Distinct from `isSpeaking`
   *  because the fetch takes about a second, and a button that still says
   *  "Listen" through it invites the second press that cancels the first. */
  isTtsLoading?: boolean
  wordSaved?: boolean
  vocabStage?: number | null
  isAuthenticated?: boolean
  /** Distance from bottom — typically reader footer height. */
  bottomOffset?: number
  /** Dismiss the toolbar. The reader passes `() => setSelection(null)` so an
   *  accidental tap on the screen doesn't strand the toolbar (B-?? mobile
   *  bug sweep). Optional for back-compat with screens that haven't wired
   *  it yet — those just lose the close affordance. */
  onClose?: () => void
}

/**
 * Single bottom toolbar for any selection. Mode is derived from
 * `isMultiWord`:
 *
 *   - single word  → shows the inline translation above the row,
 *                    plus per-word actions (save / mark-known)
 *   - multi-word   → just the action row; translation lives in
 *                    the TranslationSheet behind the Translate button
 *
 * The highlight palette collapsed into one button (matches Apple Books /
 * Kindle). Color change happens in HighlightNoteModal after the
 * highlight is created.
 */
export function SelectionActionBar({
  selectedText,
  isMultiWord,
  language,
  onTranslate,
  onExplain,
  onSpeak,
  onSaveWord,
  onHighlight,
  highlightColor = 'yellow',
  onMarkKnown,
  onRemove,
  tooLong,
  isSpeaking,
  isTtsLoading,
  wordSaved,
  vocabStage,
  isAuthenticated,
  bottomOffset = 0,
  onClose,
}: SelectionActionBarProps) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { fromLang, translationTarget } = useTargetLanguage(language)
  // A reader who has never been asked what they know is defaulted to English,
  // so on an English book `isSameLang` is true and the gloss row below simply
  // does not render — the reader long-presses a word and gets nothing, with
  // nothing on screen saying why. That silence is what makes the question
  // invisible. One tappable line replaces it, and the answering happens in the
  // sheet the line opens.
  const needsLanguage = useNeedsNativeLanguage()
  // No target means the reader already knows this language — there is nothing
  // to translate into, so the inline gloss is skipped rather than fetched.
  const isSameLang = translationTarget == null

  // Inline translation for single-word taps. Fetched here (was in the
  // deleted WordCard). Cancellation guard avoids stale results when the
  // user re-taps mid-fetch.
  const [translation, setTranslation] = useState('')
  const [translating, setTranslating] = useState(false)
  // Backend frequency hint for the tapped word — drives Save-button emphasis.
  const [category, setCategory] = useState<SaveCategory | undefined>(undefined)
  useEffect(() => {
    if (isMultiWord || !selectedText || isSameLang) {
      setTranslation('')
      setTranslating(false)
      setCategory(undefined)
      return
    }
    // Instant render on a cache hit (re-tap of a seen word) — no spinner.
    const cached = peekTranslation(selectedText, fromLang, translationTarget!)
    if (cached !== undefined) {
      setTranslation(cached.translation)
      setCategory(cached.category)
      setTranslating(false)
      return
    }
    let cancelled = false
    setTranslation('')
    setCategory(undefined)
    setTranslating(true)
    cachedTranslate(selectedText, fromLang, translationTarget!)
      .then((r) => { if (!cancelled) { setTranslation(r.translation); setCategory(r.category) } })
      .catch(() => { if (!cancelled) setTranslation('') })
      .finally(() => { if (!cancelled) setTranslating(false) })
    return () => { cancelled = true }
  }, [selectedText, isMultiWord, fromLang, translationTarget, isSameLang])

  const handleCopy = () => {
    if (selectedText) Clipboard.setStringAsync(selectedText)
  }

  const stage = !isMultiWord && vocabStage != null ? STAGE_LABELS[vocabStage] : null
  const highlightFill = HIGHLIGHT_FILLS[highlightColor] || HIGHLIGHT_FILLS.yellow

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          bottom: bottomOffset,
        },
      ]}
    >
      {/* Where the gloss would be, when we do not yet know what to gloss into.
          Opens the same sheet the Translate button does — which asks. */}
      {!isMultiWord && isSameLang && needsLanguage && (
        <TouchableOpacity
          style={styles.translationRow}
          onPress={onTranslate}
          accessibilityRole="button"
          accessibilityLabel="Choose the language to translate into"
        >
          <Ionicons name="language-outline" size={13} color={colors.primary} />
          {/* Wider than a gloss: `styles.translation` caps at 55% to leave room
              for the source word, and there is no source word on this row. */}
          <Text style={[styles.translation, { color: colors.primary, maxWidth: '85%' }]} numberOfLines={1}>
            {t('onboarding.nativeLanguageTitle')}
          </Text>
        </TouchableOpacity>
      )}

      {/* Translation row — only for single-word taps. Keeps the killer
          feature from the old WordCard (zero-tap to see translation). */}
      {!isMultiWord && !isSameLang && (
        <View style={styles.translationRow}>
          <Text style={[styles.word, { color: colors.textSecondary }]} numberOfLines={1}>
            {selectedText}
          </Text>
          <Ionicons name="arrow-forward" size={12} color={colors.textSecondary} />
          {translating ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={[styles.translation, { color: colors.text }]} numberOfLines={1}>
              {translation || '—'}
            </Text>
          )}
        </View>
      )}

      {/* Say why three buttons are dead. Dimming them alone reads as "broken":
          the reader presses, nothing happens, and that is exactly the
          impression this toolbar is supposed to stop giving. */}
      {tooLong && (
        <View style={styles.noticeRow}>
          <Ionicons name="information-circle-outline" size={13} color={colors.textSecondary} />
          <Text style={[styles.notice, { color: colors.textSecondary }]} numberOfLines={1}>
            Too long to listen, translate or explain
          </Text>
        </View>
      )}

      <View style={styles.actionsRow}>
        {isAuthenticated && onHighlight && (
          <>
            <TouchableOpacity
              style={[styles.highlightBtn, { backgroundColor: highlightFill }]}
              onPress={() => onHighlight(highlightColor)}
              accessibilityRole="button"
              accessibilityLabel={`Highlight in ${highlightColor} (tap to change color in the note editor)`}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </>
        )}

        <TouchableOpacity
          style={styles.btn}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel="Copy selection"
        >
          <Ionicons name="copy-outline" size={19} color={colors.text} />
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, tooLong && styles.btnDisabled]}
          onPress={onTranslate}
          disabled={tooLong}
          accessibilityRole="button"
          accessibilityLabel={tooLong ? 'Translate — selection too long' : 'Translate selection in full sheet'}
          accessibilityState={{ disabled: !!tooLong }}
        >
          <Ionicons name="language-outline" size={19} color={tooLong ? colors.textSecondary : colors.text} />
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Translate</Text>
        </TouchableOpacity>
        {onExplain && (
          <TouchableOpacity
            style={[styles.btn, tooLong && styles.btnDisabled]}
            onPress={onExplain}
            disabled={tooLong}
            accessibilityRole="button"
            accessibilityLabel={tooLong ? 'Explain — selection too long' : 'Explain selection in context'}
            accessibilityState={{ disabled: !!tooLong }}
          >
            <Ionicons name="bulb-outline" size={19} color={tooLong ? colors.textSecondary : colors.text} />
            <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Explain</Text>
          </TouchableOpacity>
        )}
        {/* One control, three states: idle → fetching → playing. The spinner
            stays pressable and cancels, so a download that never lands can't
            trap the reader in a button that does nothing. */}
        <TouchableOpacity
          style={[styles.btn, tooLong && styles.btnDisabled]}
          onPress={onSpeak}
          disabled={tooLong}
          accessibilityRole="button"
          accessibilityLabel={
            tooLong ? 'Listen — selection too long'
              : isTtsLoading ? 'Loading speech, tap to cancel'
              : isSpeaking ? 'Stop speech'
              : 'Read selection aloud'
          }
          accessibilityState={{ selected: !!isSpeaking, busy: !!isTtsLoading, disabled: !!tooLong }}
        >
          {isTtsLoading
            ? <ActivityIndicator size="small" color={colors.text} style={styles.btnSpinner} />
            : <Ionicons
                name={isSpeaking ? 'stop' : 'volume-high-outline'}
                size={19}
                color={tooLong ? colors.textSecondary : colors.text}
              />}
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>
            {isTtsLoading ? 'Loading' : isSpeaking ? 'Stop' : 'Listen'}
          </Text>
        </TouchableOpacity>


        {/* Per-word vocab affordances (save / mark known / stage badge).
            Save is deliberately NOT gated on a session; everything else here is.
            The reader's coachmark tells every new reader to "tap Save", and until
            this split that button was inside the auth gate — so the one control the
            app teaches was missing for exactly the readers being taught. The other
            four all describe a word that is already saved (stage badge, Known,
            the transient ✓, Remove) and mean nothing without an account, so they
            stay behind `isAuthenticated`. The guest tap is answered by the caller
            (`ReaderShell.handleSaveWord`): no request, and a toast that says the
            word was not kept — no navigation, because nothing may pull a reader
            out of the book. */}
        {!isMultiWord && (
          <>
            {isAuthenticated && stage && (
              <View
                style={[styles.stageBadge, { backgroundColor: stage.color + '20', borderColor: stage.color + '40' }]}
                accessibilityLabel={`Vocabulary stage ${stage.label}`}
              >
                <Text style={[styles.stageBadgeText, { color: stage.color }]}>{stage.label}</Text>
              </View>
            )}
            {isAuthenticated && stage && vocabStage !== 4 && onMarkKnown && (
              <TouchableOpacity
                style={styles.btn}
                onPress={onMarkKnown}
                accessibilityRole="button"
                accessibilityLabel="Mark word as known"
              >
                <Ionicons name="checkmark-done" size={19} color="#22c55e" />
                <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Known</Text>
              </TouchableOpacity>
            )}
            {/* Transient ✓ right after a save lands (before the stage badge
                takes over on next render). */}
            {isAuthenticated && !stage && wordSaved && (
              <View style={styles.btn} accessibilityLabel="Saved to vocabulary">
                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              </View>
            )}
            {/* Manual save — tap = look, this commits. Tint is a frequency
                RECOMMENDATION (learnable/rare = accent, common = muted), never
                a gate: any word can still be saved. */}
            {!stage && !wordSaved && onSaveWord && (
              <TouchableOpacity
                style={styles.btn}
                onPress={onSaveWord}
                accessibilityRole="button"
                accessibilityLabel={category === 'rare' ? 'Save word to vocabulary (rare word)' : 'Save word to vocabulary'}
              >
                <Ionicons
                  name="add-circle"
                  size={22}
                  color={category === 'common' ? colors.textSecondary : (category ? colors.success : colors.text)}
                />
                <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Save</Text>
              </TouchableOpacity>
            )}
            {/* Remove — undo an accidental save. */}
            {isAuthenticated && (stage || wordSaved) && onRemove && (
              <TouchableOpacity
                style={styles.btn}
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel="Remove word from vocabulary"
              >
                <Ionicons name="trash-outline" size={19} color={colors.textSecondary} />
                <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>Remove</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {onClose && (
          <>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              style={styles.btn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close selection toolbar"
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    // Floating selection toolbar — pinned above the reader footer so it's
    // not occluded by progress chrome. `bottom` is set inline from prop.
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  translationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.18)',
  },
  word: {
    fontFamily: fonts.serifItalic,
    fontSize: 14,
    maxWidth: '40%',
  },
  translation: {
    fontFamily: fonts.serif,
    fontSize: 15,
    maxWidth: '55%',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    rowGap: 4,
    gap: 6,
  },
  // Labels, not just accessibilityLabel. A screen reader always knew what these
  // did; a sighted reader was given Copy / a glyph / a lightbulb / a speaker and
  // left to guess. Ten characters of text costs less than the guess.
  btnLabel: {
    fontFamily: fonts.sansMedium,
    fontSize: 9,
    marginTop: 1,
  },
  // Match the 19px icon box the spinner replaces, so the row doesn't shift
  // height the moment someone presses Listen.
  btnSpinner: {
    height: 19,
    width: 19,
  },
  // Opacity, not a colour swap. text vs textSecondary on the icon is
  // indistinguishable in the light theme — verified on a device, where the
  // three dead buttons looked exactly like the live ones.
  btnDisabled: {
    opacity: 0.35,
  },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingBottom: 6,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(127,127,127,0.18)',
  },
  notice: {
    fontFamily: fonts.sansMedium,
    fontSize: 11,
  },
  btn: {
    minWidth: 46,
    paddingHorizontal: 4,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  highlightBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.15)',
  },
  divider: {
    width: 1,
    height: 22,
    marginHorizontal: 6,
  },
  stageBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
  },
  stageBadgeText: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
  },
})
