import { describe, expect, it } from 'vitest'
import { MIN_WEBVIEW_CHROME, USER_AGENT_PROBE, chromeMajor, createWebViewCheck, verdictOf, webViewStorePackage } from './webViewVersion'

// Real Android WebView user agents (the `wv` token), incl. the R4 gate's emulators (#1036).
const UA = {
  wv66: 'Mozilla/5.0 (Linux; Android 9; Android SDK built for arm64 Build/PSR1.180720.075; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.158 Mobile Safari/537.36',
  wv116: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.5845.163 Mobile Safari/537.36',
  wv117: 'Mozilla/5.0 (Linux; Android 13; Pixel 6 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.5938.60 Mobile Safari/537.36',
  // The reduced user agent (Chrome 110+): only the major is real.
  wv120reduced: 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
  wv145: 'Mozilla/5.0 (Linux; Android 17; sdk_gphone64_arm64 Build/CP31.250815.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/145.0.7632.218 Mobile Safari/537.36',
  // Android 4.3's pre-Chromium WebView: no Chrome token at all.
  legacy: 'Mozilla/5.0 (Linux; U; Android 4.3; en-us; Nexus 4 Build/JWR66Y) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30',
}

describe('V2 reader WebView floor (#1228)', () => {
  it('chromeMajor_RealWebViewUserAgents_TheMajor', () => {
    expect(chromeMajor(UA.wv66)).toBe(66)
    expect(chromeMajor(UA.wv116)).toBe(116)
    expect(chromeMajor(UA.wv117)).toBe(117)
    expect(chromeMajor(UA.wv120reduced)).toBe(120)
    expect(chromeMajor(UA.wv145)).toBe(145)
  })

  it('chromeMajor_MissingOrGarbled_Null', () => {
    for (const ua of [UA.legacy, '', 'Chrome/', 'Chrome/abc.1', 'Chrome/117', 'HeadlessChrome/120.0.0.0', 'Chrome/12345.0', null, undefined, 117, {}, { toString: () => UA.wv145 }]) {
      expect(chromeMajor(ua), String(ua)).toBeNull()
    }
  })

  it('verdictOf_AroundTheFloor', () => {
    expect(MIN_WEBVIEW_CHROME).toBe(117)
    expect(verdictOf(UA.wv66)).toBe('outdated')
    expect(verdictOf(UA.wv116)).toBe('outdated')
    expect(verdictOf(UA.wv117)).toBe('ok')
    expect(verdictOf(UA.wv120reduced)).toBe('ok')
    expect(verdictOf(UA.wv145)).toBe('ok')
    expect(verdictOf(UA.legacy)).toBe('unknown')
    expect(verdictOf(undefined)).toBe('unknown')
  })

  it('check_FirstAnswerWinsAndIsKept', () => {
    const ok = createWebViewCheck()
    expect(ok.verdict()).toBeNull()
    expect(ok.answer(UA.wv145)).toBe('ok')
    expect(ok.answer(UA.wv66)).toBe('ok')
    expect(ok.verdict()).toBe('ok')
    const old = createWebViewCheck()
    expect(old.answer(UA.wv66)).toBe('outdated')
    expect(old.answer(UA.wv145)).toBe('outdated')
    const garbled = createWebViewCheck()
    expect(garbled.answer('garbled')).toBe('unknown')
    expect(garbled.answer(UA.wv66)).toBe('unknown')
  })

  it('webViewStorePackage_Android7to9Chrome_ElseWebView', () => {
    expect(webViewStorePackage(24)).toBe('com.android.chrome')
    expect(webViewStorePackage(28)).toBe('com.android.chrome')
    expect(webViewStorePackage(29)).toBe('com.google.android.webview')
    expect(webViewStorePackage(37)).toBe('com.google.android.webview')
  })

  it('probe_IsEs5', () => {
    // No ES2015+ syntax a WebView 66 or older would choke on.
    expect(USER_AGENT_PROBE).not.toMatch(/=>|`|\?\.|\?\?|\blet\b|\bconst\b|\.\.\./)
    expect(USER_AGENT_PROBE).toContain("type: 'ua'")
  })
})
