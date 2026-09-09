import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Web may not shadow the namespaces whose wording is a legal or compliance
 * commitment.
 *
 * This replaces four deep-equality assertions that checked two copies of the
 * privacy policy, the terms and the assistant-handoff copy said the same thing.
 * They had drifted before — mobile's Terms went months without the uploads
 * warranty, the DMCA route or the liability cap, and the handoff `lead` was
 * rewritten shorter on one platform and had to be put back.
 *
 * There is one copy now, in `packages/shared/src/i18n/en.json`, and this file
 * guards the only way the old problem could come back: web's overlay silently
 * reintroducing a second version of one of these strings. "Two files must match"
 * became "there is one file and web may not override it" — strictly stronger,
 * because it also catches a divergence nobody thought to add an assertion for.
 *
 * The content rules themselves moved to `packages/shared/src/i18n/legalContent.test.ts`,
 * next to the file they describe.
 */
const overrides = JSON.parse(readFileSync(resolve(__dirname, '../en.json'), 'utf8'))

/** Top-level namespace → why web is not allowed to have its own version. */
const PROTECTED: Record<string, string> = {
  privacy: 'Google Play reads this policy from the store-listing URL; the app renders the same words.',
  terms: 'A contract. Two versions of it is two contracts.',
}

/** `namespace.child` paths that are equally off-limits. */
const PROTECTED_PATHS: Record<string, string> = {
  'library.insights': 'Tells the reader what came back from the assistant; drifted once already.',
  'library.discuss': 'Tells the reader what the handoff button does; drifted once already.',
}

describe('web overlay does not shadow shared legal copy', () => {
  for (const [ns, why] of Object.entries(PROTECTED)) {
    it(`has no ${ns}.* of its own — ${why}`, () => {
      expect(overrides[ns]).toBeUndefined()
    })
  }

  for (const [path, why] of Object.entries(PROTECTED_PATHS)) {
    it(`has no ${path}.* of its own — ${why}`, () => {
      const [parent, child] = path.split('.')
      expect(overrides[parent]?.[child]).toBeUndefined()
    })
  }
})
