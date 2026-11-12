import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Digital Asset Links — the file that decides whether a link to textstack.app opens the Android app
 * or bounces to Chrome.
 *
 * QA found `pm get-app-links app.textstack.mobile` reporting `textstack.app: 1024` — verification
 * failed — because `https://textstack.app/.well-known/assetlinks.json` answered 200 with the SPA's
 * index.html. Android asked for the statement list and got a web page, so `autoVerify` could never
 * succeed and every https link to a book, plus the password-reset email, went to the browser past an
 * installed app.
 *
 * The file lives in `public/` rather than being placed on the server because vite empties `dist/` on
 * every deploy: anything hand-copied there dies at the next build, anything in `public/` is re-copied.
 * No nginx change is needed — `/.well-known/…` matches no regex location and falls through to
 * `location /`, whose `try_files $uri /index.html` serves a real file when one exists.
 *
 * The fingerprint is not in the repo and cannot be: the build is signed by Play App Signing, so the
 * SHA-256 comes from Play Console or `eas credentials`. Rather than leave CI red for everyone until
 * someone pastes it — which would block every unrelated PR — the strict check activates itself the
 * moment the placeholder is replaced. Until then the file's shape is still pinned, so the one manual
 * step is "paste 32 hex bytes", not "work out the format". See docs/internal/ops/android-app-links.md.
 */
const PLACEHOLDER = 'REPLACE_WITH_PLAY_APP_SIGNING_SHA256'
describe('assetlinks.json', () => {
  const raw = readFileSync(
    resolve(__dirname, '../../public/.well-known/assetlinks.json'),
    'utf-8',
  )

  it('is valid JSON in the shape Android expects', () => {
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].relation).toContain('delegate_permission/common.handle_all_urls')
    expect(parsed[0].target.namespace).toBe('android_app')
  })

  it('names the package the app actually ships as', () => {
    // Must match `expo.android.package` in apps/mobile/app.json. A mismatch fails verification
    // silently — Android reports the same 1024 it reported for a missing file.
    const parsed = JSON.parse(raw)
    expect(parsed[0].target.package_name).toBe('app.textstack.mobile')
  })

  it('lists exactly one fingerprint slot, awaiting a real one', () => {
    // Shape is pinned whether or not the fingerprint has landed, so the manual step stays
    // "paste 32 hex bytes" and cannot turn into "work out what goes here".
    const parsed = JSON.parse(raw)
    const prints: string[] = parsed[0].target.sha256_cert_fingerprints
    expect(Array.isArray(prints)).toBe(true)
    expect(prints.length).toBeGreaterThan(0)
  })

  // Activates by itself the moment the placeholder is replaced — no second commit to "turn on
  // the test", which is the step that gets forgotten.
  it.skipIf(raw.includes(PLACEHOLDER))(
    'every fingerprint is 32 colon-separated hex bytes, as Play prints them',
    () => {
      const prints: string[] = JSON.parse(raw)[0].target.sha256_cert_fingerprints
      for (const print of prints) {
        expect(print).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i)
      }
    },
  )
})
