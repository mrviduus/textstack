/** TR-3: the saved translation to show as "Saved as: …" next to "Use this translation", or null
 *  when there is nothing to offer (nothing saved, nothing shown, or the two already agree). */
export function savedTranslationOffer(saved: string | null | undefined, shown: string | null | undefined): string | null {
  const s = saved?.trim()
  const b = shown?.trim()
  return s && b && s !== b ? s : null
}
