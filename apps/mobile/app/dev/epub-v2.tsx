import type { ComponentType } from 'react'
import { Redirect } from 'expo-router'

/**
 * V2 reader dev route (ADR-029 Decision 5): dev builds only, linked from nowhere.
 * Reach it on a dev build with
 *   npx uri-scheme open textstack://dev/epub-v2 --android
 * (or `adb shell am start -a android.intent.action.VIEW -d textstack://dev/epub-v2`).
 *
 * The screen is required inside the `__DEV__` branch and nothing else here runs first: a release
 * build inlines `__DEV__` as false and drops the branch, so the screen and the reader page are not
 * in its bundle. Production Metro also hides this file; see metro.config.js.
 */
const Screen: ComponentType = __DEV__ ? require('../../src/components/v2reader/V2ReaderScreen').default : () => <Redirect href="/" />

export default Screen
