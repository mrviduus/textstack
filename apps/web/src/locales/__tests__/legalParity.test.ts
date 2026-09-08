import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PRIVACY_SECTIONS } from '@textstack/shared'

// Google Play requires the privacy policy inside the app and the policy at the URL
// listed on the store listing to say the same thing. They are two hand-maintained
// JSON files — apps/web/src/locales/en.json for the website, packages/shared for the
// mobile app — and they have already drifted apart once: mobile's Terms were missing
// the uploads warranty, the DMCA route and the liability cap for months.
//
// A mismatch here is not a typo. It is either a compliance gap or a promise made to
// one set of users and not the other.
// Same relative-path pattern as no-duplicate-keys.test.ts, which already reaches
// across into packages/shared from here.
const web = JSON.parse(readFileSync(resolve(__dirname, '../en.json'), 'utf8'))
const shared = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../packages/shared/src/i18n/en.json'), 'utf8'),
)

// The same hazard, one section over. `library.insights` and `library.discuss` are
// the assistant handoff: the words that tell a reader what the button does and
// what came back from the conversation. They live in both files because the two
// apps read different catalogues, and nothing but this test stops a wording fix
// on one screen from leaving the other saying something else. It has already
// happened once here — the mobile `lead` was written shorter "for the small
// screen" and had to be put back.
describe('assistant-handoff copy parity between web and mobile', () => {
  for (const block of ['insights', 'discuss'] as const) {
    it(`library.${block}.* is identical in both locale files`, () => {
      expect(shared.library[block]).toEqual(web.library[block])
    })
  }
})

describe('legal text parity between web and mobile', () => {
  for (const block of ['privacy', 'terms'] as const) {
    it(`${block}.* is identical in both locale files`, () => {
      expect(shared[block]).toEqual(web[block])
    })
  }

  it('every key PRIVACY_SECTIONS references exists in both files', () => {
    const keys = PRIVACY_SECTIONS.flatMap(s => [
      s.heading,
      ...s.bodies,
      ...(s.link ? [s.link.label] : []),
    ])
    const missing: string[] = []
    for (const key of keys) {
      const [block, leaf] = key.split('.')
      if (typeof web[block]?.[leaf] !== 'string') missing.push(`web:${key}`)
      if (typeof shared[block]?.[leaf] !== 'string') missing.push(`shared:${key}`)
    }
    expect(missing).toEqual([])
  })

  it('states a retention answer for AI interaction records', () => {
    // The one disclosure most likely to be quietly dropped in a future rewrite: the
    // llm_traces table keeps prompts and book excerpts, and has no cleanup job. The
    // policy has to keep saying so.
    expect(web.privacy.retentionBody3.toLowerCase()).toContain('indefinitely')
  })

  it('names the third parties that actually receive user content', () => {
    const thirdParties = Object.entries(web.privacy)
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
    const all = JSON.stringify(web.privacy).toLowerCase()
    expect(all).not.toContain('stored locally in your browser')
  })

  it('no longer claims nothing is shared with third parties', () => {
    const all = JSON.stringify(web.privacy).toLowerCase()
    expect(all).not.toContain('do not sell, rent, or share your personal information with third parties')
  })
})
