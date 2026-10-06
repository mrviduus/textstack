/**
 * Global toast provider — single-slot, animated, safe-area aware.
 *
 * Why: we need a lightweight way to surface transient feedback ("word added
 * to vocabulary", "offline — saved locally", etc.) without blocking input.
 * React Native has no built-in primitive for this and we don't want to pull
 * in a third-party dep for a single-use UI pattern.
 *
 * Contract:
 *   const { show } = useToast()
 *   show({ message: 'Added to vocabulary', variant: 'success' })
 *
 * Behavior:
 *   - One toast visible at a time. A new show() replaces the previous.
 *   - Auto-dismisses after `duration` ms (default 2200).
 *   - Slides up from the bottom, fades in; on dismiss fades + slides down.
 *   - Non-interactive background — toast sits above the tab bar, taps pass
 *     through to content. A tap on the toast dismisses it; only the action
 *     label runs `onPress`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from './ThemeContext'
import { fonts } from '../theme/typography'

export type ToastVariant = 'success' | 'info' | 'error'

export interface ToastOptions {
  message: string
  variant?: ToastVariant
  /** Leading icon override. If omitted, a sensible default per variant is picked. */
  icon?: keyof typeof Ionicons.glyphMap
  /** Auto-dismiss duration in ms. Default 2200. 0 = sticky (no auto dismiss). */
  duration?: number
  /** The action behind `actionLabel` — run by the label only. A tap on the body dismisses (M1):
   *  a reader swatting a toast away must not be taken somewhere. */
  onPress?: () => void
  /** Optional CTA label shown on the right. Requires onPress. */
  actionLabel?: string
  /**
   * Optional pixel value (above the home indicator) for this toast.
   * Use when the screen has no tab bar (modal, reader) and the default
   * offset would float in dead space. Falls back to the provider default
   * (sized to clear the bottom tab bar).
   */
  bottomOffset?: number
}

interface ToastContextValue {
  /** Returns the toast's id, for `dismiss`. */
  show: (options: ToastOptions) => number
  hide: () => void
  /** Hide the toast `id` — only if it is still the one on screen. For a screen dismissing its own
   *  toast on unmount without taking down whatever replaced it. */
  dismiss: (id: number | null) => void
}

const ToastContext = createContext<ToastContextValue>({
  show: () => 0,
  hide: () => {},
  dismiss: () => {},
})

const DEFAULT_DURATION = 2200
// Matches `(tabs)/_layout.tsx`: tab bar = 52 (iOS) / 56 (Android) + insets.
// Add a small visual gap so the toast doesn't kiss the tab bar border.
const TAB_BAR_VISUAL_HEIGHT = 56
const TOAST_GAP = 12

export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastOptions | null>(null)
  const translateY = useRef(new Animated.Value(40)).current
  const opacity = useRef(new Animated.Value(0)).current
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef(0)
  const currentIdRef = useRef<number | null>(null)
  const insets = useSafeAreaInsets()
  const { colors, isDark } = useTheme()

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 40,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) { setCurrent(null); currentIdRef.current = null }
    })
  }, [clearTimer, opacity, translateY])

  const dismiss = useCallback((id: number | null) => {
    if (id != null && id === currentIdRef.current) hide()
  }, [hide])

  const show = useCallback(
    (options: ToastOptions) => {
      clearTimer()
      const id = ++idRef.current
      currentIdRef.current = id
      setCurrent(options)
      // Snap values so the new toast animates in from off-screen regardless
      // of where the previous one was in its lifecycle.
      translateY.setValue(40)
      opacity.setValue(0)
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 260,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start()

      const duration = options.duration ?? DEFAULT_DURATION
      if (duration > 0) {
        timerRef.current = setTimeout(hide, duration)
      }
      return id
    },
    [clearTimer, hide, opacity, translateY],
  )

  useEffect(() => {
    return () => clearTimer()
  }, [clearTimer])

  const value = useMemo<ToastContextValue>(
    () => ({ show, hide, dismiss }),
    [show, hide, dismiss],
  )

  const variant = current?.variant ?? 'info'
  const variantColor =
    variant === 'success' ? '#10B981' : variant === 'error' ? colors.error : colors.primary
  const defaultIcon: keyof typeof Ionicons.glyphMap =
    variant === 'success'
      ? 'checkmark-circle'
      : variant === 'error'
        ? 'alert-circle'
        : 'information-circle'
  const iconName = current?.icon ?? defaultIcon
  // Bottom offset: per-call override → tab-bar-clearing default → safe
  // area. Screens without a tab bar (reader, modals) pass a smaller
  // `bottomOffset` per call to avoid floating in dead space (B-18).
  const bottomOffset =
    insets.bottom + (current?.bottomOffset ?? TAB_BAR_VISUAL_HEIGHT + TOAST_GAP)

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current ? (
        <View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, styles.wrap]}
        >
          <Animated.View
            style={[
              styles.toastOuter,
              {
                bottom: bottomOffset,
                opacity,
                transform: [{ translateY }],
              },
            ]}
          >
            <Pressable
              onPress={hide}
              accessibilityLabel={current.message}
              style={[
                styles.toast,
                {
                  backgroundColor: isDark ? '#1F1F1F' : '#111827',
                  borderColor: variantColor,
                },
              ]}
            >
              <Ionicons name={iconName} size={18} color={variantColor} />
              <Text style={styles.message} numberOfLines={2}>
                {current.message}
              </Text>
              {current.actionLabel && current.onPress ? (
                <Pressable
                  onPress={() => { hide(); current.onPress?.() }}
                  accessibilityRole="button"
                  accessibilityLabel={current.actionLabel}
                  hitSlop={12}
                >
                  <Text style={[styles.action, { color: variantColor }]}>
                    {current.actionLabel}
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

const styles = StyleSheet.create({
  wrap: {
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  toastOuter: {
    position: 'absolute',
    left: 16,
    right: 16,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: 480,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 8,
  },
  message: {
    flex: 1,
    color: '#F9FAFB',
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 18,
  },
  action: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
})
