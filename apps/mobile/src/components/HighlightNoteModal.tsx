import { useState, useEffect, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Modal,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'

export type HighlightColor = 'yellow' | 'green' | 'pink' | 'blue'

const COLOR_SWATCHES: { key: HighlightColor; fill: string }[] = [
  { key: 'yellow', fill: '#fef08a' },
  { key: 'green', fill: '#bbf7d0' },
  { key: 'pink', fill: '#fbcfe8' },
  { key: 'blue', fill: '#bfdbfe' },
]

export interface HighlightNoteModalProps {
  visible: boolean
  /** Short snippet of the highlighted passage rendered above the input. */
  snippet: string
  /** Existing note, prefilled into the text field when present. */
  initialNote?: string | null
  /** Current color of the highlight — render the matching swatch as selected. */
  initialColor?: HighlightColor
  onCancel: () => void
  /**
   * The note as typed (trimmed), and `base`: the note the draft was typed over (the one shown when typing began, or the
   * latest shown if untouched): a caller writes nothing when they are the same.
   */
  onSave: (note: string, base: string | null) => void
  /** The note is not known yet (#1312 review, V2: a row from before notes, not pulled yet): the field waits, Save is off. */
  noteLoading?: boolean
  /** Called when the user picks a different color swatch. Fires immediately
   *  (no Save click required) — color is a single-tap commit, the editor's
   *  Save covers the note text only. */
  onColorChange?: (color: HighlightColor) => void
  onDelete: () => void
}

/**
 * Cross-platform replacement for `Alert.prompt`, which only exists on iOS.
 * On Android the old call silently failed — users could neither edit nor
 * delete a highlight note (B-02).
 *
 * Design notes:
 *  - Kept visually aligned with `BookmarksSheet` (slide-up sheet, themed
 *    surface) so it feels native in context.
 *  - Uses `KeyboardAvoidingView` so the input isn't hidden by the keyboard
 *    on small phones.
 *  - Resets draft text whenever the modal reopens with a different note,
 *    avoiding stale-state bugs when editing two highlights in sequence.
 */
export function HighlightNoteModal({
  visible,
  snippet,
  initialNote,
  initialColor,
  onCancel,
  onSave,
  onColorChange,
  onDelete,
  noteLoading = false,
}: HighlightNoteModalProps) {
  const { colors } = useTheme()
  const [note, setNote] = useState(initialNote || '')
  const [color, setColor] = useState<HighlightColor | undefined>(initialColor)
  const inputRef = useRef<TextInput>(null)
  /** The reader has typed since the editor opened; `base`: the note the draft is typed over. */
  const touched = useRef(false)
  const base = useRef<string | null>(initialNote ?? null)

  // The draft starts from the highlight's note when the editor opens: a colour tap re-renders the caller with a new
  // `initialColor`, which must not wipe a note being typed (#1312 review). A caller showing another highlight closes
  // the editor first (or keys it).
  useEffect(() => {
    if (visible) {
      touched.current = false
      base.current = initialNote ?? null
      setNote(initialNote || '')
      setColor(initialColor)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])
  // Untouched, the draft follows the note as it loads or changes (#1312 review): a save never replaces a note unseen.
  useEffect(() => {
    if (!visible || touched.current) return
    base.current = initialNote ?? null
    setNote(initialNote || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNote])
  const edit = (text: string) => {
    touched.current = true
    setNote(text)
  }

  const handleColorPick = (c: HighlightColor) => {
    setColor(c)
    onColorChange?.(c)
  }

  // Auto-focus the input shortly after mount so the keyboard comes up
  // without requiring a second tap. setTimeout avoids a race with the
  // Modal's open animation on iOS.
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => inputRef.current?.focus(), 150)
    return () => clearTimeout(t)
  }, [visible])

  const handleSave = () => { if (!noteLoading) onSave(note.trim(), base.current) }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close highlight note"
        >
          <Pressable
            style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}
            onPress={e => e.stopPropagation()}
          >
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Highlight Note</Text>
            {snippet ? (
              <Text style={[styles.snippet, { color: colors.textSecondary }]} numberOfLines={3}>
                "{snippet}"
              </Text>
            ) : null}

            {/* Color swatch row — single-tap commits the new color. */}
            {onColorChange && (
              <View style={styles.swatchRow}>
                {COLOR_SWATCHES.map(sw => (
                  <TouchableOpacity
                    key={sw.key}
                    onPress={() => handleColorPick(sw.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Set highlight color ${sw.key}`}
                    accessibilityState={{ selected: color === sw.key }}
                    style={[
                      styles.swatch,
                      { backgroundColor: sw.fill },
                      color === sw.key && {
                        borderColor: colors.text,
                        borderWidth: 2,
                      },
                    ]}
                  />
                ))}
              </View>
            )}

            <TextInput
              ref={inputRef}
              value={note}
              onChangeText={edit}
              editable={!noteLoading}
              placeholder={noteLoading ? 'Loading the note…' : 'Add a note…'}
              placeholderTextColor={colors.textSecondary}
              multiline
              accessibilityLabel="Highlight note"
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
            />

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost]}
                onPress={onDelete}
                accessibilityRole="button"
                accessibilityLabel="Delete highlight"
              >
                <Text style={[styles.btnText, { color: colors.error }]}>Delete</Text>
              </TouchableOpacity>
              <View style={styles.spacer} />
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost]}
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.btnText, { color: colors.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary }, noteLoading && { opacity: 0.4 }]}
                onPress={handleSave}
                disabled={noteLoading}
                accessibilityState={{ disabled: noteLoading }}
                accessibilityRole="button"
                accessibilityLabel="Save note"
              >
                <Text style={[styles.btnText, { color: '#fff' }]}>Save</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  title: {
    fontSize: 18,
    fontFamily: fonts.sansBold,
    marginBottom: 6,
  },
  snippet: {
    fontSize: 14,
    fontStyle: 'italic',
    marginBottom: 14,
  },
  swatchRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
    alignItems: 'center',
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.1)',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  btn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  btnGhost: {},
  btnPrimary: {},
  btnText: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
  },
  spacer: { flex: 1 },
})
