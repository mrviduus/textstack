import { useSyncExternalStore } from 'react'

const query = () => (typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null)

/** True on a phone-width screen: the one breakpoint of the phone design (styles use the same `max-width: 640px`). */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const q = query()
      q?.addEventListener('change', changed)
      return () => q?.removeEventListener('change', changed)
    },
    () => !!query()?.matches,
  )
}
