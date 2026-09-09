import { describe, it, expect } from 'vitest'
import en from './en.json'
import { PRIVACY_SECTIONS } from '../legal/sections'

/**
 * The compliance controls on the privacy policy and terms.
 *
 * These used to live in `apps/web/src/locales/__tests__/legalParity.test.ts` and
 * assert that two hand-maintained copies said the same thing. Google Play requires
 * the policy inside the app and the policy at the store-listing URL to agree, and
 * the two copies HAD drifted: mobile's Terms were missing the uploads warranty, the
 * DMCA route and the liability cap for months.
 *
 * There is one copy now — this file — read by the mobile app directly and by the
 * website through `apps/web/src/locales/catalog.ts`. Parity is structural rather
 * than asserted, which is why the assertions moved here rather than being deleted:
 * the *content* rules were never about parity. Web additionally forbids itself from
 * shadowing these namespaces (`apps/web/src/locales/__tests__/legalShadow.test.ts`),
 * so "two files must match" became "there is one file, and web may not override it"
 * — strictly stronger.
 *
 * A failure here is not a typo. It is either a compliance gap or a promise made to
 * one set of users and not the other.
 */
type Node = Record<string, unknown>
const privacy = (en as Node).privacy as Record<string, string>

describe('legal content', () => {
  it('every key PRIVACY_SECTIONS references resolves to a string', () => {
    // `PRIVACY_SECTIONS` is a shared list of key names that BOTH apps render. A key
    // it points at that is missing here renders as the key itself on both platforms.
    const keys = PRIVACY_SECTIONS.flatMap(s => [
      s.heading,
      ...s.bodies,
      ...(s.link ? [s.link.label] : []),
    ])
    const missing = keys.filter(key => {
      const [block, leaf] = key.split('.')
      return typeof ((en as Node)[block] as Node | undefined)?.[leaf] !== 'string'
    })
    expect(missing).toEqual([])
  })

  it('states a retention answer for AI interaction records', () => {
    // The one disclosure most likely to be quietly dropped in a future rewrite: the
    // llm_traces table keeps prompts and book excerpts, and has no cleanup job. The
    // policy has to keep saying so.
    expect(privacy.retentionBody3.toLowerCase()).toContain('indefinitely')
  })

  it('names the third parties that actually receive user content', () => {
    const thirdParties = Object.entries(privacy)
      .filter(([k]) => k.startsWith('thirdParties'))
      .map(([, v]) => String(v))
      .join(' ')
    for (const processor of ['OpenAI', 'Microsoft', 'Google', 'Apple', 'Resend', 'Sentry', 'Cloudflare']) {
      expect(thirdParties).toContain(processor)
    }
  })

  it('no longer claims data is stored only in the browser', () => {
    // The exact sentence that made the old policy false for a mobile app with server
    // accounts. Guarding the claim, not the wording that replaced it.
    expect(JSON.stringify(privacy).toLowerCase()).not.toContain('stored locally in your browser')
  })

  it('no longer claims nothing is shared with third parties', () => {
    expect(JSON.stringify(privacy).toLowerCase())
      .not.toContain('do not sell, rent, or share your personal information with third parties')
  })
})
