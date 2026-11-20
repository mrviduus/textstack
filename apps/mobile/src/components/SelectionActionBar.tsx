import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { cachedTranslate, peekTranslation, type SaveCategory } from '../lib/translateCache'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useTargetLanguage } from '../hooks/useTargetLanguage'
import { useNeedsNativeLanguage } from '../hooks/useNeedsNativeLanguage'
import { fonts } from '../theme/typography'
import { savedTranslationOffer, MAX_VOCABULARY_TEXT } from '@textstack/shared'
import { fill } from '../lib/fill'

const STAGE_LABELS: Record<number, { label: string; color: string }> = {
  // Stage 0's label is a word: said through `t` (reader.actionBar.stageNew).
  0: { label: '', color: '#3b82f6' },
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
  /** The surrounding sentence, sent with the translate call. */
  sentence?: string
  /** editionId / userBookId — the server biases the sense by the book's genre. */
  bookId?: string
  /** Source language code — used for fetching the inline translation
   *  when text is selected. Same value the reader passes to TTS. */
  language?: string
  onTranslate: () => void
  onExplain?: () => void
  /** Absent: no Listen (the V2 reader until its TTS slice, #1272). */
  onSpeak?: () => void
  /** Absent: no Save. */
  onSaveWord?: (translation?: string) => void
  onSaveQuote?: () => void
  onHighlight?: (color: HighlightColorKey) => void
  /** Last color the user picked — used as the single highlight button's
   *  fill. Tapping commits this color; change via HighlightNoteModal after. */
  highlightColor?: HighlightColorKey
  /** Remove the word from vocabulary — lets the user undo an accidental save. */
  onRemove?: () => void
  /** Selection is past the 500-character ceiling the speech and translation
   *  endpoints enforce. Those two and Explain are disabled; Copy and
   *  Highlight still work, which is why the toolbar opens at all. */
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
  /** After Copy (the V2 reader ends the selection, as the web toolbar does). */
  onCopy?: () => void
  /** TR-3: the tapped word's saved translation — offered for replacement when the gloss differs. */
  savedTranslation?: string
  onUseTranslation?: (translation: string) => void
}

/** One card for any native text selection. Translation and vocabulary do not depend on word count. */
export function SelectionActionBar({
  selectedText,
  sentence,
  bookId,
  language,
  onTranslate,
  onExplain,
  onSpeak,
  onSaveWord,
  onSaveQuote,
  onHighlight,
  highlightColor = 'yellow',
  onRemove,
  tooLong,
  isSpeaking,
  isTtsLoading,
  wordSaved,
  vocabStage,
  isAuthenticated,
  bottomOffset = 0,
  onClose,
  onCopy,
  savedTranslation,
  onUseTranslation,
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

  // Inline translation for any selection. Fetched here (was in the
  // deleted WordCard). Cancellation guard avoids stale results when the
  // user re-taps mid-fetch.
  const [translation, setTranslation] = useState('')
  const [translatedText, setTranslatedText] = useState('')
  const [translating, setTranslating] = useState(false)
  /** The gloss fetch failed: said in the bar, never a reason to stop reading. */
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const { height: screenHeight } = useWindowDimensions()
  useEffect(() => { setExpanded(false) }, [selectedText, fromLang, translationTarget])
  const saveTooLong = selectedText.trim().length > MAX_VOCABULARY_TEXT
  const explainTooLong = selectedText.trim().length > 100
  // TR-3: the language `translation` was fetched in — for one render after a native-language
  // change it is still the old one, and must not be offered as "Use this translation".
  const [translationLang, setTranslationLang] = useState<string | null>(null)
  // Backend frequency hint for the selection — drives Save-button emphasis.
  const [category, setCategory] = useState<SaveCategory | undefined>(undefined)
  useEffect(() => {
    setFailed(false)
    if (tooLong || !selectedText || isSameLang) {
      setTranslation('')
      setTranslating(false)
      setCategory(undefined)
      return
    }
    // Instant render on a cache hit (re-tap of a seen word) — no spinner.
    const ctx = { sentence, bookId }
    const cached = peekTranslation(selectedText, fromLang, translationTarget!, ctx)
    if (cached !== undefined) {
      setTranslation(cached.translation)
      setTranslatedText(selectedText)
      setTranslationLang(translationTarget)
      setCategory(cached.category)
      setTranslating(false)
      return
    }
    let cancelled = false
    setTranslation('')
    setCategory(undefined)
    setTranslating(true)
    const timer = setTimeout(() => {
      cachedTranslate(selectedText, fromLang, translationTarget!, ctx)
      .then((r) => { if (!cancelled) { setTranslation(r.translation); setTranslatedText(selectedText); setTranslationLang(translationTarget); setCategory(r.category) } })
      .catch(() => { if (!cancelled) { setTranslation(''); setFailed(true) } })
      .finally(() => { if (!cancelled) setTranslating(false) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [selectedText, sentence, bookId, tooLong, fromLang, translationTarget, isSameLang, retry])

  const handleCopy = () => {
    if (selectedText) Clipboard.setStringAsync(selectedText)
    onCopy?.()
  }

  const stage = vocabStage != null ? STAGE_LABELS[vocabStage] : null
  const savedAs = !isSameLang ? savedTranslationOffer(savedTranslation, translating ? null : translation, translationLang, translationTarget) : null
  const highlightFill = HIGHLIGHT_FILLS[highlightColor] || HIGHLIGHT_FILLS.yellow
  const stageLabel = stage && (stage.label || t('reader.actionBar.stageNew'))

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
      {isSameLang && needsLanguage && (
        <TouchableOpacity
          style={styles.translationRow}
          onPress={onTranslate}
          accessibilityRole="button"
          accessibilityLabel={t('reader.actionBar.chooseLanguage')}
        >
          <Ionicons name="language-outline" size={13} color={colors.primary} />
          {/* Wider than a gloss: `styles.translation` caps at 55% to leave room
              for the source word, and there is no source word on this row. */}
          <Text style={[styles.translation, { color: colors.primary, maxWidth: '85%' }]} numberOfLines={1}>
            {t('onboarding.nativeLanguageTitle')}
          </Text>
        </TouchableOpacity>
      )}

      {/* One inline translation for a word or phrase. */}
      {!isSameLang && (
        <>
        <ScrollView
          style={{ flexGrow: 0, maxHeight: Math.min(260, screenHeight * 0.4) }}
          contentContainerStyle={styles.translationRow}
          scrollEnabled={expanded}
          nestedScrollEnabled
        >
          <Text style={[styles.word, { color: colors.textSecondary }]} numberOfLines={expanded ? undefined : 3}>
            {selectedText}
          </Text>
          <Ionicons name="arrow-down" size={12} color={colors.textSecondary} />
          {translating ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={[styles.translation, { color: colors.text }]} numberOfLines={expanded ? undefined : 4}>
              {failed ? t('reader.actionBar.translateFailed') : translation || '—'}
            </Text>
          )}
        </ScrollView>
        {!!translation && !translating && !failed && <TouchableOpacity
          style={styles.expandTranslation}
          onPress={() => setExpanded(value => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={t(expanded ? 'reader.actionBar.collapseTranslation' : 'reader.actionBar.showFullTranslation')}
        >
          <Text style={[styles.btnLabel, { color: colors.primary }]}>{t(expanded ? 'reader.actionBar.collapseTranslation' : 'reader.actionBar.showFullTranslation')}</Text>
        </TouchableOpacity>}
        </>
      )}

      {savedAs && onUseTranslation && (
        <View style={styles.translationRow}>
          <Text style={[styles.word, { color: colors.textSecondary }]} numberOfLines={1}>
            {t('reader.vocab.savedAs')} {savedAs}
          </Text>
          <TouchableOpacity onPress={() => onUseTranslation(translation)} accessibilityRole="button">
            <Text style={[styles.translation, { color: colors.primary }]} numberOfLines={1}>
              {t('reader.vocab.useThisTranslation')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Say why three buttons are dead. Dimming them alone reads as "broken":
          the reader presses, nothing happens, and that is exactly the
          impression this toolbar is supposed to stop giving. */}
      {tooLong && (
        <View style={styles.noticeRow}>
          <Ionicons name="information-circle-outline" size={13} color={colors.textSecondary} />
          <Text style={[styles.notice, { color: colors.textSecondary }]} numberOfLines={1}>
            {t('reader.actionBar.tooLong')}
          </Text>
        </View>
      )}

      {explainTooLong && !tooLong && onExplain && <View style={styles.noticeRow}><Text style={[styles.notice, { color: colors.textSecondary }]}>{t('reader.actionBar.explainLimit')}</Text></View>}
      {saveTooLong && onSaveWord && <View style={styles.noticeRow}><Text style={[styles.notice, { color: colors.textSecondary }]}>{t('reader.actionBar.saveTooLong')}</Text></View>}
      <View style={styles.actionsRow}>
        {isAuthenticated && onHighlight && (
          <>
            <TouchableOpacity
              style={[styles.highlightBtn, { backgroundColor: highlightFill }]}
              onPress={() => onHighlight(highlightColor)}
              accessibilityRole="button"
              accessibilityLabel={fill(t('reader.actionBar.highlightIn'), { color: t(`reader.highlightColor.${highlightColor}`) })}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            />
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
          </>
        )}

        <TouchableOpacity
          style={styles.btn}
          onPress={handleCopy}
          accessibilityRole="button"
          accessibilityLabel={t('reader.actionBar.copySelection')}
        >
          <Ionicons name="copy-outline" size={19} color={colors.text} />
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.copy')}</Text>
        </TouchableOpacity>
        {failed && <TouchableOpacity style={styles.btn} onPress={() => setRetry(n => n + 1)} accessibilityRole="button" accessibilityLabel={t('reader.actionBar.retryTranslation')}>
          <Ionicons name="refresh" size={19} color={colors.text} />
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.retryTranslation')}</Text>
        </TouchableOpacity>}
        {onSaveQuote && <TouchableOpacity style={styles.btn} onPress={onSaveQuote} accessibilityRole="button" accessibilityLabel={t('reader.actionBar.saveQuote')}>
          <Ionicons name="bookmark-outline" size={19} color={colors.text} />
          <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.quote')}</Text>
        </TouchableOpacity>}
        {onExplain && (
          <TouchableOpacity
            style={[styles.btn, explainTooLong && styles.btnDisabled]}
            onPress={onExplain}
            disabled={explainTooLong}
            accessibilityRole="button"
            accessibilityLabel={t(explainTooLong ? 'reader.actionBar.explainTooLong' : 'reader.actionBar.explainInContext')}
            accessibilityState={{ disabled: !!explainTooLong }}
          >
            <Ionicons name="bulb-outline" size={19} color={explainTooLong ? colors.textSecondary : colors.text} />
            <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.explain')}</Text>
          </TouchableOpacity>
        )}
        {/* One control, three states: idle → fetching → playing. The spinner
            stays pressable and cancels, so a download that never lands can't
            trap the reader in a button that does nothing. */}
        {onSpeak && <TouchableOpacity
          style={[styles.btn, tooLong && styles.btnDisabled]}
          onPress={onSpeak}
          disabled={tooLong}
          accessibilityRole="button"
          accessibilityLabel={t(
            tooLong ? 'reader.actionBar.listenTooLong'
              : isTtsLoading ? 'reader.actionBar.listenLoading'
              : isSpeaking ? 'reader.actionBar.stopSpeech'
              : 'reader.actionBar.readAloud',
          )}
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
            {t(isTtsLoading ? 'reader.actionBar.loading' : isSpeaking ? 'reader.actionBar.stop' : 'reader.actionBar.listen')}
          </Text>
        </TouchableOpacity>}


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
        {(
          <>
            {isAuthenticated && stage && (
              <View
                style={[styles.stageBadge, { backgroundColor: stage.color + '20', borderColor: stage.color + '40' }]}
                accessibilityLabel={fill(t('reader.actionBar.stage'), { stage: stageLabel || '' })}
              >
                <Text style={[styles.stageBadgeText, { color: stage.color }]}>{stageLabel}</Text>
              </View>
            )}
            {/* Transient ✓ right after a save lands (before the stage badge
                takes over on next render). */}
            {isAuthenticated && !stage && wordSaved && (
              <View style={styles.btn} accessibilityLabel={t('reader.actionBar.saved')}>
                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              </View>
            )}
            {/* Manual save — tap = look, this commits. Tint is a frequency
                RECOMMENDATION (learnable/rare = accent, common = muted), never
                a gate: any word can still be saved. */}
            {!stage && !wordSaved && onSaveWord && (
              <TouchableOpacity
                style={[styles.btn, saveTooLong && styles.btnDisabled]}
                onPress={() => onSaveWord?.(!translating && translatedText === selectedText && translationLang === translationTarget ? translation || undefined : undefined)}
                disabled={saveTooLong}
                accessibilityState={{ disabled: saveTooLong }}
                accessibilityRole="button"
                accessibilityLabel={t(saveTooLong ? 'reader.actionBar.saveTooLong' : 'reader.actionBar.saveSelection')}
              >
                <Ionicons
                  name="add-circle"
                  size={22}
                  color={category === 'common' ? colors.textSecondary : (category ? colors.success : colors.text)}
                />
                <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.save')}</Text>
              </TouchableOpacity>
            )}
            {/* Remove — undo an accidental save. */}
            {isAuthenticated && (stage || wordSaved) && onRemove && (
              <TouchableOpacity
                style={styles.btn}
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel={t('reader.actionBar.removeWord')}
              >
                <Ionicons name="trash-outline" size={19} color={colors.textSecondary} />
                <Text style={[styles.btnLabel, { color: colors.textSecondary }]}>{t('reader.actionBar.remove')}</Text>
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
              accessibilityLabel={t('reader.actionBar.close')}
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
  expandTranslation: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    flexDirection: 'column',
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
    fontSize: 16,
    maxWidth: '100%',
  },
  translation: {
    fontFamily: fonts.serif,
    fontSize: 18,
    maxWidth: '100%',
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
    fontSize: 11,
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
