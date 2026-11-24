import AsyncStorage from '@react-native-async-storage/async-storage'
import { forgetChapterPositions } from './positionHandoff'

/**
 * Reading-progress keys older builds kept in AsyncStorage. Nothing writes or reads them now (#1551): the V2
 * reader keeps its places in the local library (#1532) and reading states come from the feed. Kept so the
 * sign-out wipe still removes an older build's rows: catalog (edition) progress, the per-upload record
 * (`reading.progress.userbook.`, under the first prefix), an upload's PDF flag and its reading-state revision.
 */
const OLD_PREFIXES = ['reading.progress.', 'reading.userbook-is-pdf.', 'reading.userbook-v2-state.']

/**
 * Wipe every locally-cached reading-progress row. Called on sign-out so
 * user A's last page never leaks to user B when they sign in on the same
 * device. Never throws — progress is non-critical transient state.
 */
export async function clearAllLocalProgress(): Promise<void> {
  forgetChapterPositions()
  try {
    const keys = await AsyncStorage.getAllKeys()
    const progressKeys = keys.filter(k => OLD_PREFIXES.some(p => k.startsWith(p)))
    if (progressKeys.length === 0) return
    await AsyncStorage.multiRemove(progressKeys)
  } catch {
    // Storage unavailable — ignore.
  }
}
