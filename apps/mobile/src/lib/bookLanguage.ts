/**
 * The language of the text on the page (M5) — what TTS speaks it in, what
 * translate/explain read it as, and what a saved word is filed under.
 *
 * The reader used the APP language for all of these, which is the catalog's
 * language (one site, one language) but not an upload's: a Ukrainian reader of a
 * German PDF got German read aloud with an English voice and translated "from
 * English". An upload carries its own language; a missing or junk value falls
 * back to the app language, as before.
 */
export function readerTextLanguage(bookLanguage: string | null | undefined, appLanguage: string): string {
  const code = bookLanguage?.trim()
  return code && /^[a-z]{2,3}([-_][a-z0-9]+)*$/i.test(code) && code.toLowerCase() !== 'und' ? code : appLanguage
}
