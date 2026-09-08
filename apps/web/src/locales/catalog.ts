import { translations as sharedTranslations } from '@textstack/shared'
import overrides from './en.json'

/**
 * The web app's string catalogue: the shared source with web's own file laid over it.
 *
 * Strings used to live in two hand-maintained copies — `packages/shared/src/i18n/en.json`
 * for mobile, this directory's `en.json` for web — sharing 547 key paths that nothing
 * compared. 523 were identical and 24 had quietly drifted. Shared is the source now;
 * `en.json` here holds what only the website has (SEO pages, DMCA, the MCP landing, the
 * device-approval flow) plus a small set of deliberate overrides.
 *
 * **Web wins at every leaf.** An override is a decision, so it takes precedence — and
 * because it is now the ONLY reason a key appears twice, every one of them is visible.
 */

export interface TranslationNode {
  [key: string]: string | string[] | TranslationNode
}

const isNode = (v: unknown): v is TranslationNode =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Deep merge, right-hand side wins, **returning a new tree**.
 *
 * The new tree is not tidiness. `Object.assign(shared.en, web)` would mutate the
 * module-cached shared catalogue for every other importer in the process — including
 * the shared package's own `t()`, and, under vitest, every other test file sharing the
 * worker's module cache. That is the easiest possible way to write a merge that passes
 * its own tests and corrupts somebody else's.
 *
 * Arrays replace rather than concatenate. There are none in either file today, but
 * `tArray` is a real API and "append" would be a surprising default for a translation.
 */
export function mergeCatalog(base: TranslationNode, over: TranslationNode, path = ''): TranslationNode {
  const out: TranslationNode = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const here = path ? `${path}.${key}` : key
    const existing = out[key]
    if (isNode(existing) && isNode(value)) {
      out[key] = mergeCatalog(existing, value, here)
      continue
    }
    // A path that is a string on one side and an object on the other has no correct
    // merge — the result would depend on which file was read first, and the loser's
    // subtree would vanish silently. Refuse rather than pick.
    if (isNode(existing) !== isNode(value) && existing !== undefined) {
      throw new Error(
        `Translation catalogue collision at "${here}": ` +
        `${isNode(existing) ? 'object' : 'string'} in shared, ` +
        `${isNode(value) ? 'object' : 'string'} in web. One of them has to change.`,
      )
    }
    out[key] = value
  }
  return out
}

/**
 * Built once, at module load. `useTranslation`'s `t` is memoised on `[language]`, and
 * merging a 1200-key tree inside the hook would throw that away on every render.
 */
export const catalog: TranslationNode = mergeCatalog(
  sharedTranslations.en as TranslationNode,
  overrides as TranslationNode,
)
