import { describe, it, expect } from 'vitest'
import { classify, parseMismatches } from './check-expo-alignment.mjs'

// Verbatim from the failing CI run on 2026-09-29.
const PATCH_LAG = `The following packages should be updated for best compatibility with the installed expo version:
  expo@57.0.25 - expected version: ~57.0.26
  expo-constants@57.0.19 - expected version: ~57.0.20
  expo-document-picker@57.0.2 - expected version: ~57.0.3
  expo-router@57.0.23 - expected version: ~57.0.24
  expo-updates@57.0.23 - expected version: ~57.0.24
Your project may not work correctly until you install the expected versions of the packages.`

describe('classify', () => {
  it('passes a clean check', () => {
    expect(classify(0, 'Dependencies are up to date').outcome).toBe('aligned')
  })

  it('treats patch-only lag as a warning, not a failure', () => {
    // The whole reason this exists: a patch release upstream must not turn every PR red.
    const r = classify(1, PATCH_LAG)
    expect(r.outcome).toBe('patch-lag')
    expect(r.mismatches.map(m => m.name)).toEqual(['expo', 'expo-constants', 'expo-document-picker', 'expo-router', 'expo-updates'])
  })

  it('fails when one package is off by a minor, even among patch lags', () => {
    // The case the check was written for — react-native 0.87 against an SDK that expects 0.83.
    const out = `${PATCH_LAG}\n  react-native@0.87.1 - expected version: 0.83.10`
    expect(classify(1, out).outcome).toBe('drift')
  })

  it('fails on a major mismatch', () => {
    expect(classify(1, '  react-native-webview@14.0.0 - expected version: 13.15.0').outcome).toBe('drift')
  })

  it('handles scoped package names', () => {
    const r = classify(1, '  @expo/ui@57.0.20 - expected version: ~57.0.21')
    expect(r.outcome).toBe('patch-lag')
    expect(r.mismatches[0].name).toBe('@expo/ui')
  })

  it('refuses to wave through a failure it cannot read', () => {
    // A network error or a changed output format must fail loudly, never pass as "only patches".
    expect(classify(1, 'Error: getaddrinfo ENOTFOUND registry.npmjs.org').outcome).toBe('unreadable')
    expect(classify(1, '  expo - expected version: something new').outcome).toBe('unreadable')
  })
})

describe('parseMismatches', () => {
  it('keeps installed and expected versions', () => {
    expect(parseMismatches('  expo-router@57.0.23 - expected version: ~57.0.24')).toEqual([
      { name: 'expo-router', installed: '57.0.23', expected: '57.0.24', patchOnly: true },
    ])
  })
})
