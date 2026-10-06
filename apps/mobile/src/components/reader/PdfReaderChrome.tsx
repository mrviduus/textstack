import { useRef, useState } from 'react'
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Animated, Keyboard, PanResponder, Modal, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { fonts } from '../../theme/typography'

interface Props {
  barBg: string
  barText: string
  borderColor: string
  barsAnim: Animated.Value
  footerTranslateY: Animated.AnimatedInterpolation<number>
  barsVisible: boolean
  bottomInset: number
  /** 1-based top-visible page. */
  currentPage: number
  /** Total pages (0 until the doc loads). */
  numPages: number
  /** Jump the viewer to a 1-based page (clamped inside the viewer). */
  onJumpToPage: (page: number) => void
}

/**
 * Footer chrome for the Original-layout PDF reader (ADR-012 S4c). Replaces the
 * reflow chapter-nav footer: a page-fraction progress bar, a "go to page" input
 * and the "N / total" indicator. Zoom/fit is intentionally omitted — the viewer
 * exposes no zoom message, so adding it would change the viewer contract (the
 * WebView already fit-scales to width + honours pinch). Page-jump routes through
 * the same `window.scrollToPage(n)` bridge the TOC and resume paths use.
 */
export function PdfReaderChrome({
  barBg, barText, borderColor, barsAnim, footerTranslateY, barsVisible,
  bottomInset, currentPage, numPages, onJumpToPage,
}: Props) {
  const [pageInput, setPageInput] = useState('')
  const [typing, setTyping] = useState(false)
  // Page under the finger while dragging. Null when not dragging, so the counter
  // falls back to where the viewer actually is.
  const [scrubPage, setScrubPage] = useState<number | null>(null)
  const trackWidthRef = useRef(0)
  // Where the drag started, in track coordinates. PanResponder's moveX is a
  // SCREEN coordinate while locationX is relative to the view, so mixing them
  // offsets every drag by the track's position on screen.
  const grantXRef = useRef(0)
  // The side effect on release reads this, not the state setter — running an
  // effect inside a state updater fires twice under StrictMode.
  const scrubPageRef = useRef<number | null>(null)

  const submit = () => {
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n) && n >= 1) onJumpToPage(n) // viewer clamps overflow
    closeInput()
  }
  const closeInput = () => {
    setPageInput('')
    setTyping(false)
    Keyboard.dismiss()
  }

  const pageAt = (x: number) => {
    const w = trackWidthRef.current
    if (!w || numPages < 1) return 1
    const f = Math.max(0, Math.min(1, x / w))
    return Math.max(1, Math.min(numPages, Math.round(f * (numPages - 1)) + 1))
  }

  // Drag the bar to move through the book. The bar was already there, drawn as a
  // read-only fill; it just could not be touched. What could be touched was a
  // 56px-wide numeric field showing "1 /" clipped, plus a Go button — a desktop
  // control on a phone, and QA said so.
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => numPages > 1,
      onMoveShouldSetPanResponder: () => numPages > 1,
      onPanResponderGrant: e => {
        grantXRef.current = e.nativeEvent.locationX
        const p = pageAt(grantXRef.current)
        scrubPageRef.current = p
        setScrubPage(p)
      },
      onPanResponderMove: (_e, g) => {
        const p = pageAt(grantXRef.current + g.dx)
        scrubPageRef.current = p
        setScrubPage(p)
      },
      onPanResponderRelease: () => {
        const p = scrubPageRef.current
        scrubPageRef.current = null
        setScrubPage(null)
        if (p != null) onJumpToPage(p)
      },
      onPanResponderTerminate: () => { scrubPageRef.current = null; setScrubPage(null) },
    }),
  ).current

  const shownPage = scrubPage ?? currentPage
  const fraction = numPages >= 1 ? Math.min(1, shownPage / numPages) : 0

  return (
    <Animated.View
      style={[
        styles.footer,
        {
          backgroundColor: barBg,
          borderTopColor: borderColor,
          paddingBottom: bottomInset,
          opacity: barsAnim,
          transform: [{ translateY: footerTranslateY }],
          // Android's elevation shadow is drawn by the native outline provider
          // and ignores the animated opacity, so it stayed on the page as a dark
          // line across the text after the bar faded out. Same fix as the reflow
          // footer in ReaderShell.
          elevation: barsVisible ? 2 : 0,
          borderTopWidth: barsVisible ? StyleSheet.hairlineWidth : 0,
        },
      ]}
      pointerEvents={barsVisible ? 'auto' : 'none'}
    >
      <View
        style={styles.trackHit}
        onLayout={e => { trackWidthRef.current = e.nativeEvent.layout.width }}
        accessibilityRole="adjustable"
        accessibilityLabel="Scrub through pages"
        accessibilityValue={{ min: 1, max: Math.max(1, numPages), now: shownPage }}
        {...pan.panHandlers}
      >
        <View style={[styles.progressBar, { backgroundColor: borderColor }]}>
          <View style={[styles.progressFill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: barText + (scrubPage != null ? '99' : '40') }]} />
        </View>
        {numPages > 1 && (
          <View
            style={[
              styles.knob,
              {
                left: `${Math.round(fraction * 100)}%`,
                backgroundColor: barText,
                transform: [{ scale: scrubPage != null ? 1.4 : 1 }],
              },
            ]}
            pointerEvents="none"
          />
        )}
      </View>
      {/* M7: the field lived in this footer, pinned to the bottom of an edge-to-edge
          window, so the keyboard covered it — the reader typed blind. It opens in a
          Modal instead, a window of its own with the card at the TOP, where no
          keyboard reaches whatever the window does on resize. Back closes it. */}
      <Modal visible={typing} transparent animationType="fade" onRequestClose={closeInput}>
        <Pressable style={styles.backdrop} onPress={closeInput} accessibilityLabel="Close page input">
          <Pressable style={[styles.jumpCard, { backgroundColor: barBg, borderColor }]} onPress={e => e.stopPropagation()}>
            <View style={styles.jumpWrap}>
              <TextInput
                style={[styles.input, { color: barText, borderColor: barText + '30' }]}
                value={pageInput}
                onChangeText={t => setPageInput(t.replace(/\D/g, ''))}
                onSubmitEditing={submit}
                placeholder={String(currentPage)}
                placeholderTextColor={barText + '66'}
                keyboardType="number-pad"
                returnKeyType="go"
                inputMode="numeric"
                maxLength={6}
                autoFocus
                accessibilityLabel="Go to page"
              />
              <Text style={[styles.counter, { color: barText + '99' }]}>/ {numPages || '…'}</Text>
              <TouchableOpacity
                onPress={submit}
                style={[styles.goBtn, { borderColor: barText + '30' }]}
                accessibilityRole="button"
                accessibilityLabel="Go to page"
              >
                <Text style={[styles.goText, { color: barText + 'CC' }]}>Go</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      <View style={styles.row}>
        <View style={styles.jumpWrap} />
        {/* Tapping the counter is the way to a precise page. Dragging 500 pages
            to reach 87 is not navigation, but neither is a permanent input box. */}
        <TouchableOpacity
          onPress={() => { if (!typing) setTyping(true) }}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Page ${shownPage} of ${numPages || 'unknown'}. Tap to enter a page number.`}
        >
          <Text style={[styles.counter, { color: barText + (scrubPage != null ? 'EE' : '99') }]}>
            {shownPage} / {numPages || '…'}
          </Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
}

/** A corrupt / unreadable PDF (`pdfLoadError`): read the extracted text instead, or go back. */
export function PdfErrorOverlay({ bg, barText, buttonColor, topInset, bottomInset, canReadAsText, onPress }: {
  bg: string
  barText: string
  buttonColor: string
  topInset: number
  bottomInset: number
  /** Reflow chapters exist to fall back to. */
  canReadAsText: boolean
  onPress: () => void
}) {
  return (
    <View style={[styles.pdfErrorOverlay, { backgroundColor: bg, paddingTop: topInset, paddingBottom: bottomInset }]}>
      <Ionicons name="alert-circle-outline" size={48} color={barText + '99'} />
      <Text style={[styles.pdfErrorTitle, { color: barText }]}>Couldn't open this PDF</Text>
      <Text style={[styles.pdfErrorBody, { color: barText + '99' }]}>
        {canReadAsText
          ? 'The original file could not be displayed. You can read the extracted text version instead.'
          : 'The original file could not be displayed, and there is no text version to fall back to.'}
      </Text>
      <TouchableOpacity
        style={[styles.pdfErrorBtn, { backgroundColor: buttonColor }]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={canReadAsText ? 'Read as text' : 'Go back'}
      >
        <Text style={styles.pdfErrorBtnText}>{canReadAsText ? 'Read as text' : 'Go back'}</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    // borderTopWidth and elevation are inline — both must vanish when hidden.
  },
  // A touch target around the 4px bar. The bar itself stays thin — the finger
  // needs the room, the eye does not.
  trackHit: { height: 22, justifyContent: 'center' },
  knob: { position: 'absolute', width: 10, height: 10, borderRadius: 5, marginLeft: -5 },
  progressBar: { height: 4 },
  progressFill: { height: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8, minHeight: 48 },
  jumpWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', paddingTop: 120 },
  jumpCard: { padding: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  input: {
    minWidth: 56,
    height: 34,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    fontFamily: fonts.sans,
    fontVariant: ['tabular-nums'],
  },
  goBtn: { height: 34, paddingHorizontal: 12, justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  goText: { fontSize: 13, fontFamily: fonts.sansMedium },
  counter: { fontSize: 13, fontFamily: fonts.sans, fontVariant: ['tabular-nums'] },
  pdfErrorOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 150,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 8,
  },
  pdfErrorTitle: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 12, textAlign: 'center' },
  pdfErrorBody: { fontFamily: fonts.sans, fontSize: 14, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  pdfErrorBtn: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 20 },
  pdfErrorBtnText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
})
