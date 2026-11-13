import { describe, expect, it } from 'vitest'
import { ALIGNS, DEFAULTS, FAMILIES, FONT_MAX, FONT_MIN, LINE_HEIGHTS, THEMES, choose, parseChosen, readChosen, readSettings, settingsCss } from './settings.mjs'

const BLOB = 'blob:https://appassets.androidplatform.net/3f2c1a9e-0000-4000-8000-1234567890ab'

describe('v2 reader settings', () => {
  it('readSettings_Nothing_Defaults', () => {
    for (const raw of [null, undefined, 'dark', 7, [], {}]) expect(readSettings(raw)).toEqual(DEFAULTS)
  })

  it('readSettings_ValidChoices_Kept', () => {
    const s = { fontSize: 24, lineHeight: 1.8, fontFamily: 'dyslexic', textAlign: 'justify', theme: 'dark' }
    expect(readSettings(s)).toEqual(s)
  })

  it.each([[13, FONT_MIN], [-5, FONT_MIN], [29, FONT_MAX], [1e9, FONT_MAX], [17.6, 18], [FONT_MIN, FONT_MIN], [FONT_MAX, FONT_MAX]])('readSettings_FontSize%s_ClampedWhole', (given, want) => {
    expect(readSettings({ fontSize: given }).fontSize).toBe(want)
  })

  it.each([['20'], [NaN], [Infinity], [null], [[20]], [{}], [true]])('readChosen_FontSize%s_Dropped', (fontSize) => {
    expect(readChosen({ fontSize })).toEqual({})
  })

  it('readChosen_LineHeight_OnlyTheFourSteps', () => {
    expect(LINE_HEIGHTS).toHaveLength(4)
    for (const lh of LINE_HEIGHTS) expect(readChosen({ lineHeight: lh })).toEqual({ lineHeight: lh })
    for (const lh of [1.7, 0, 99, '1.8', null]) expect(readChosen({ lineHeight: lh })).toEqual({})
  })

  it('readChosen_ClosedLists_OnlyTheirMembers', () => {
    for (const v of FAMILIES) expect(readChosen({ fontFamily: v })).toEqual({ fontFamily: v })
    for (const v of ALIGNS) expect(readChosen({ textAlign: v })).toEqual({ textAlign: v })
    for (const v of Object.keys(THEMES)) expect(readChosen({ theme: v })).toEqual({ theme: v })
    // 'system' was the legacy reader's sans; `toString`/`__proto__` are on every object.
    for (const v of ['system', 'Serif', '', 'toString', '__proto__', 'constructor', ['serif'], { toString: () => 'serif' }, 0, null]) {
      expect(readChosen({ fontFamily: v, textAlign: v, theme: v })).toEqual({})
    }
  })

  it('readChosen_OlderOrForeignShape_OnlyKnownValidKeysSurvive', () => {
    // The legacy reader's stored settings: other keys, a family this reader does not know.
    const legacy = { fontSize: 22, lineHeight: 1.65, fontFamily: 'system', textAlign: 'left', theme: 'sepia', ttsSpeed: 1.5, ttsVoiceEn: 'en-US-AriaNeural', autoLookup: true }
    expect(readChosen(legacy)).toEqual({ fontSize: 22, lineHeight: 1.65, textAlign: 'left', theme: 'sepia' })
  })

  it('readChosen_InheritedKeys_NotRead', () => {
    expect(readChosen(Object.create({ theme: 'dark', fontSize: 24 }))).toEqual({})
  })

  it('parseChosen_Malformed_None', () => {
    for (const json of [null, undefined, '', '{', 'null', '"dark"', '[1,2]', '{"theme":"neon"}']) expect(parseChosen(json)).toEqual({})
  })

  it('parseChosen_Stored_RoundTrips', () => {
    const chosen = choose({}, { theme: 'dark', fontSize: 24 })
    expect(parseChosen(JSON.stringify(chosen))).toEqual({ theme: 'dark', fontSize: 24 })
  })

  it('choose_OnlyWhatTheReaderChose_DefaultsNotStored', () => {
    // A default that changes later still reaches a reader who never chose that setting.
    const chosen = choose({}, { fontSize: 22 })
    expect(chosen).toEqual({ fontSize: 22 })
    expect(readSettings(chosen)).toEqual({ ...DEFAULTS, fontSize: 22 })
  })

  it('choose_PatchOverEarlierChoices_InvalidPatchChangesNothing', () => {
    const chosen = choose({ theme: 'sepia', fontSize: 22 }, { fontSize: 99 })
    expect(chosen).toEqual({ theme: 'sepia', fontSize: FONT_MAX })
    expect(choose(chosen, { theme: 'neon' } as never)).toEqual(chosen)
  })
})

describe('v2 reader settings stylesheet', () => {
  it('settingsCss_Defaults_SizeLineFamilyAlignColours', () => {
    const css = settingsCss(DEFAULTS)
    expect(css).toContain('font-size: 20px !important')
    expect(css).toContain('line-height: 1.6 !important')
    expect(css).toContain('Georgia')
    expect(css).toContain('text-align: center !important')
    expect(css).toContain(`color: ${THEMES.light.fg} !important; background: ${THEMES.light.bg} !important`)
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('body *')
  })

  it('settingsCss_Left_IsStart', () => {
    expect(settingsCss({ textAlign: 'left' })).toContain('text-align: start !important')
  })

  it('settingsCss_Dark_RecoloursEverything', () => {
    const css = settingsCss({ theme: 'dark' })
    expect(css).toContain(`background: ${THEMES.dark.bg} !important`)
    expect(css).toContain('body * { color: inherit !important')
    expect(settingsCss({ theme: 'sepia' })).not.toContain('color: inherit')
  })

  it('settingsCss_Dyslexic_FaceFromTheBlobUrlAndEveryElement', () => {
    const css = settingsCss({ fontFamily: 'dyslexic' }, BLOB)
    expect(css).toContain(`@font-face { font-family: "TextStack OpenDyslexic"; src: url(${BLOB}) format("woff2"); }`)
    expect(css).toContain('body * { font-family: inherit !important; }')
  })

  it('settingsCss_AnotherFamily_NoFaceEvenWithAUrl', () => {
    expect(settingsCss({ fontFamily: 'sans' }, BLOB)).not.toContain('@font-face')
  })

  it.each([['https://evil.tst/f.woff2'], ['data:font/woff2;base64,AAAA'], ['blob:x) } body { display: none } @font-face { src: url(blob:y'], [`${BLOB}"`], [null], [undefined], [{}]])('settingsCss_FontUrl%s_NotABlobUrl_NoFace', (url) => {
    const css = settingsCss({ fontFamily: 'dyslexic' }, url as never)
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('display')
    // The family still falls back to sans.
    expect(css).toContain('"TextStack OpenDyslexic", sans-serif')
  })

  it('settingsCss_HostileValues_SameSheetAsTheDefaults', () => {
    const hostile = { fontSize: '20px } * { display: none', lineHeight: '1; } body { color: red', fontFamily: 'x; } body { display: none', textAlign: 'left; } * { color: red', theme: '} html { display: none', extra: 'url(https://evil.tst)' }
    expect(settingsCss(hostile)).toBe(settingsCss(DEFAULTS))
  })

  it('settingsCss_EveryValidCombination_OnlyKnownText', () => {
    // Whatever is chosen, the sheet is built from the module's own constants and two numbers.
    for (const fontFamily of FAMILIES) for (const textAlign of ALIGNS) for (const theme of Object.keys(THEMES)) for (const lineHeight of LINE_HEIGHTS) {
      const css = settingsCss({ fontSize: 18, lineHeight, fontFamily, textAlign, theme }, BLOB)
      expect(css).toMatch(/^[\w\s.,:;{}()#"*!@/-]+$/)
      expect(css.match(/url\(/g)?.length ?? 0).toBe(fontFamily === 'dyslexic' ? 1 : 0)
    }
  })
})
