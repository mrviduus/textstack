import { Pressable, StyleSheet, Text, View } from 'react-native'

/**
 * The end-of-book block (#1266), host UI over the page (never injected into the book): "Finish book" while the
 * book's end is on screen (`showsFinishBook`), the finished label once it is. The write is local (the outbox
 * carries it to the server), so there is no waiting state; a second tap changes nothing (set once).
 */
export function V2FinishBook({ finished, onFinish, bottom, background, color, accent, finishLabel, finishedLabel }: {
  finished: boolean
  onFinish: () => void
  /** Px above the screen's bottom edge: over the footer when the bars are shown. */
  bottom: number
  background: string
  color: string
  accent: string
  finishLabel: string
  finishedLabel: string
}) {
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom }]}>
      {finished ? (
        <Text testID="v2-finished" accessibilityLiveRegion="polite" style={[styles.pill, styles.label, { backgroundColor: background, color }]}>{finishedLabel}</Text>
      ) : (
        <Pressable testID="v2-finish" onPress={onFinish} accessibilityRole="button" accessibilityLabel={finishLabel} style={[styles.pill, { backgroundColor: accent }]}>
          <Text style={[styles.label, styles.onAccent]}>{finishLabel}</Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, zIndex: 10, alignItems: 'center' },
  pill: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, borderRadius: 22, overflow: 'hidden' },
  label: { fontSize: 15, fontWeight: '600', textAlignVertical: 'center' },
  onAccent: { color: '#fff' },
})
