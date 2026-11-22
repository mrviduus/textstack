import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { DiscussFailure, DiscussShared, DiscussState } from '@textstack/shared'
import { withTitle } from '../../../../../packages/reader/src/toc.mjs'

/** The host's words (`reader.v2.discuss.*`), one per state and per failure. */
export type V2DiscussLabels = Record<'start' | 'startTitled' | 'sharing' | 'shared' | 'cut' | 'open' | 'retry' | DiscussFailure, string>

/**
 * The end-of-chapter Discuss of the Android V2 reader (#1316): host UI over the page, never injected into the book.
 * A tap shares the chapter's text with the reader's account (`onShare`, which then opens the chat); what happened
 * stays on the pill: shared (or shared in part, for a chapter over the size cap) with a way back into the chat, or
 * why not, with a retry. `title` is the contents entry's label, the book's own text: shown as text only.
 */
export function V2ChapterDiscuss({ title, state, onShare, onOpen, bottom, background, color, accent, labels }: {
  title: string | null
  state: DiscussState | undefined
  onShare: () => void
  /** Opens the chat for a share already made. */
  onOpen: (shared: DiscussShared) => void
  /** Px above the screen's bottom edge. */
  bottom: number
  background: string
  color: string
  accent: string
  labels: V2DiscussLabels
}) {
  const sharing = state?.phase === 'sharing'
  const note = state?.phase === 'ready' ? (state.shared.cut ? labels.cut : labels.shared) : state?.phase === 'failed' ? labels[state.reason] : null
  const action = state?.phase === 'ready' ? labels.open : sharing ? labels.sharing : state?.phase === 'failed' ? labels.retry : labels.start
  const name = !state && title ? withTitle(labels.startTitled, title) : action
  return (
    <View pointerEvents="box-none" testID="v2-discuss" style={[styles.wrap, { bottom }]}>
      {note && (
        <Text testID="v2-discuss-note" accessibilityLiveRegion={state?.phase === 'failed' ? 'assertive' : 'polite'} style={[styles.note, { backgroundColor: background, color }]}>{note}</Text>
      )}
      <Pressable
        testID={state?.phase === 'ready' ? 'v2-discuss-open' : 'v2-discuss-share'}
        onPress={() => (state?.phase === 'ready' ? onOpen(state.shared) : onShare())}
        disabled={sharing}
        accessibilityRole="button"
        accessibilityLabel={name}
        accessibilityState={{ disabled: sharing, busy: sharing }}
        style={[styles.pill, { backgroundColor: accent, opacity: sharing ? 0.6 : 1 }]}
      >
        <Text style={[styles.label, styles.onAccent]}>{action}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, zIndex: 10, alignItems: 'center', gap: 6 },
  note: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, overflow: 'hidden', fontSize: 13, textAlign: 'center' },
  pill: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 22, overflow: 'hidden' },
  label: { fontSize: 15, fontWeight: '600', textAlignVertical: 'center' },
  onAccent: { color: '#fff' },
})
