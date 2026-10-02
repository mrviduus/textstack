import { useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'

/**
 * Run `effect` when the screen comes BACK into view — never on the first focus,
 * and never because `effect`'s identity changed.
 *
 * For screens whose mount effect already loads: a plain `useFocusEffect` also
 * fires on the first focus, and re-fires whenever its callback is re-created
 * (a `loading` or filter dep), each time a second copy of the same requests.
 */
export function useRefocusEffect(effect: () => void | (() => void)) {
  const effectRef = useRef(effect)
  effectRef.current = effect
  const focusedOnceRef = useRef(false)
  useFocusEffect(useCallback(() => {
    if (!focusedOnceRef.current) { focusedOnceRef.current = true; return }
    return effectRef.current()
  }, []))
}
