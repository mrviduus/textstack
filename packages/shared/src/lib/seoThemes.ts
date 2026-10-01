/**
 * Defensive parse of the `SeoThemesJson` DB column.
 *
 * Historically a `string[]`, but SEO backfill / older imports wrote
 * `Array<{ theme, description }>` for some rows. Web detail pages and the
 * admin Edition/Author editors map themes straight into a string render —
 * feeding the object form to React triggers "Objects are not valid as a
 * React child" (saw it live on /en/books/father-goriot).
 *
 * Coerce any non-string element to its `theme` field (preferred) or to
 * `String(item)` as a last resort. Safe to remove once the DB is
 * normalized. Shared by web and admin (admin imports it by deep path).
 */
export function parseSeoThemes(raw: string | null | undefined): string[] {
  if (!raw) return []
  let arr: unknown
  try { arr = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.map(item => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object' && 'theme' in item && typeof (item as { theme: unknown }).theme === 'string') {
      return (item as { theme: string }).theme
    }
    return String(item ?? '')
  }).filter(Boolean)
}
