import { translationApi } from '@textstack/shared'

export type { TranslateContext } from '@textstack/shared'

export interface LanguageInfo {
  code: string
  name: string
}

/** The shared translate (TR-1 body); a failure is an `ApiError` carrying its status (#1271: a 429 stops the backfill). */
export const translate = translationApi.translate
