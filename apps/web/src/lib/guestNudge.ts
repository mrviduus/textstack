/**
 * "Keep your words — create an account" nudge on a guest's 3rd and 10th saved word.
 * Each fires once per browser; never for accounts (the caller decides who is a guest).
 */
export type GuestNudge = 'three' | 'ten'

const KEYS: Record<GuestNudge, string> = {
  three: 'guestNudge.three',
  ten: 'guestNudge.ten',
}

function seen(n: GuestNudge): boolean {
  try { return localStorage.getItem(KEYS[n]) === '1' } catch { return true } // no storage → never nag
}

function mark(n: GuestNudge) {
  try { localStorage.setItem(KEYS[n], '1') } catch { /* private mode */ }
}

/** Returns the nudge earned at `savedCount` words (and records it), or null. */
export function takeGuestNudge(savedCount: number): GuestNudge | null {
  if (savedCount >= 10 && !seen('ten')) {
    mark('ten')
    mark('three') // a 3-word nudge after the 10-word one would read backwards
    return 'ten'
  }
  if (savedCount >= 3 && !seen('three')) {
    mark('three')
    return 'three'
  }
  return null
}
