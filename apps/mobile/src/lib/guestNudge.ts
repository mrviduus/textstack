import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * The "keep your words — create an account" nudge a guest sees on saving a word.
 *
 * Two moments: the 3rd and the 10th saved word. Each at most once per install,
 * never for an account, never without a session. `>=` rather than `===` so a
 * count that jumps past the threshold (a guest who already had words before
 * this shipped, a map that loaded late) still gets the moment once — and only
 * the higher one: a guest on word 15 is not told "3 words saved".
 */
export type GuestNudge = 'three' | 'ten'

const KEYS: Record<GuestNudge, string> = {
  three: 'guestNudge.three.shown',
  ten: 'guestNudge.ten.shown',
}

/** Pure decision. `shown` is which nudges this install has already spent. */
export function pickGuestNudge(
  isGuest: boolean,
  savedCount: number,
  shown: Record<GuestNudge, boolean>,
): GuestNudge | null {
  if (!isGuest) return null
  if (savedCount >= 10) return shown.ten ? null : 'ten'
  if (savedCount >= 3) return shown.three ? null : 'three'
  return null
}

/**
 * Decide and spend: returns the nudge to show (and records it as shown), or
 * null for the ordinary "word saved" toast. Storage failure → null, never a throw:
 * a nudge is never worth losing the save confirmation over.
 */
export async function claimGuestNudge(isGuest: boolean, savedCount: number): Promise<GuestNudge | null> {
  if (!isGuest || savedCount < 3) return null
  try {
    const [three, ten] = await Promise.all([AsyncStorage.getItem(KEYS.three), AsyncStorage.getItem(KEYS.ten)])
    const nudge = pickGuestNudge(isGuest, savedCount, { three: three === '1', ten: ten === '1' })
    if (!nudge) return null
    await AsyncStorage.setItem(KEYS[nudge], '1')
    // The 10th supersedes the 3rd: once past it, "3 words saved" would be a lie.
    if (nudge === 'ten') await AsyncStorage.setItem(KEYS.three, '1')
    return nudge
  } catch {
    return null
  }
}
