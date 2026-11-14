import { useEffect, useState } from 'react'
import { AccessibilityInfo } from 'react-native'

/**
 * The system's "remove animations" setting, live (#1267): a sheet that slides in opens without moving when it is on.
 * False until the answer comes (a first frame may still animate).
 */
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let live = true
    AccessibilityInfo.isReduceMotionEnabled().then((r) => { if (live) setReduce(r) }, () => {})
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      live = false
      sub.remove()
    }
  }, [])
  return reduce
}
