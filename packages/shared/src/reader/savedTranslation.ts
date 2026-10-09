/** TR-3: the saved translation to show as "Saved as: …" next to "Use this translation", or null
 *  when there is nothing to offer (nothing saved, nothing shown, the two already agree in any case,
 *  or the shown translation is not in the reader's current native language). */
export function savedTranslationOffer(
  saved: string | null | undefined,
  shown: string | null | undefined,
  shownLang: string | null | undefined,
  nativeLang: string | null | undefined,
): string | null {
  const s = saved?.trim()
  const b = shown?.trim()
  if (!s || !b || !shownLang || !nativeLang) return null
  if (shownLang.toLocaleLowerCase() !== nativeLang.toLocaleLowerCase()) return null
  return s.toLocaleLowerCase() !== b.toLocaleLowerCase() ? s : null
}
