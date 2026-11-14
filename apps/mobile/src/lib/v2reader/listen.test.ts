import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TTS_VOICES, createListener, readSpeed, speakingJs, ttsVoice } from './listen.mjs'

// #1272: the voice a book is spoken in, and the speed, on both hosts.

describe('ttsVoice', () => {
  it('german_AGermanVoice', () => {
    expect(ttsVoice('de', 'en')).toEqual({ lang: 'de', voice: 'de-DE-KatjaNeural' })
  })

  it('portuguese_APortugueseVoice', () => {
    expect(ttsVoice('pt', 'en')).toEqual({ lang: 'pt', voice: 'pt-BR-FranciscaNeural' })
  })

  it('regionOrUnderscore_ByItsLanguage', () => {
    expect(ttsVoice('pt-PT', 'en')).toEqual({ lang: 'pt', voice: 'pt-BR-FranciscaNeural' })
    expect(ttsVoice('de_AT', 'en')).toEqual({ lang: 'de', voice: 'de-DE-KatjaNeural' })
    expect(ttsVoice(' FR-ca ', 'en')).toEqual({ lang: 'fr', voice: 'fr-FR-DeniseNeural' })
  })

  it('threeLetterCode_ItsLanguage', () => {
    expect(ttsVoice('deu', 'en')).toEqual({ lang: 'de', voice: 'de-DE-KatjaNeural' })
    expect(ttsVoice('fre', 'en')).toEqual({ lang: 'fr', voice: 'fr-FR-DeniseNeural' })
  })

  it('english_TheEnglishVoice', () => {
    expect(ttsVoice('en-GB', 'de')).toEqual({ lang: 'en', voice: 'en-US-AriaNeural' })
  })

  it('unknownLanguage_ItsOwnCodeNoVoice_NeverEnglish', () => {
    expect(ttsVoice('sw', 'en')).toEqual({ lang: 'sw', voice: null })
    expect(ttsVoice('xyz', 'en')).toEqual({ lang: 'xyz', voice: null })
  })

  it('noLanguage_TheFallback', () => {
    expect(ttsVoice('', 'es')).toEqual({ lang: 'es', voice: 'es-ES-ElviraNeural' })
    expect(ttsVoice(undefined, 'en')).toEqual({ lang: 'en', voice: 'en-US-AriaNeural' })
    expect(ttsVoice('12', 'it')).toEqual({ lang: 'it', voice: 'it-IT-ElsaNeural' })
  })

  it('ukrainian_NoListen', () => {
    expect(ttsVoice('uk', 'en')).toBeNull()
    expect(ttsVoice('ukr', 'en')).toBeNull()
    expect(ttsVoice('', 'uk')).toBeNull()
  })

  it('nothingReadsAsALanguage_NoListen', () => {
    expect(ttsVoice('', '')).toBeNull()
    expect(ttsVoice(42, null)).toBeNull()
  })

  it('everyNonEnglishLanguage_NeverAnEnUsVoice', () => {
    for (const [code, voice] of Object.entries(TTS_VOICES)) {
      expect(voice.startsWith(code === 'no' ? 'nb-' : `${code}-`)).toBe(true)
      expect(ttsVoice(code, 'en')?.voice).toBe(voice)
    }
  })

  it('voices_AreTheServerDefaults', () => {
    const cs = readFileSync(resolve(__dirname, '../../../../../backend/src/Tts/TextStack.Tts/TtsConfiguration.cs'), 'utf8')
    const server = Object.fromEntries([...cs.matchAll(/\["(\w+)"\] = "([\w-]+)"/g)].map((m) => [m[1], m[2]]))
    expect(TTS_VOICES).toEqual(server)
  })
})

describe('readSpeed', () => {
  it('aListedSpeed_Kept', () => {
    expect([0.75, 1, 1.25, 1.5, 2].map(readSpeed)).toEqual([0.75, 1, 1.25, 1.5, 2])
    expect(readSpeed('1.5')).toBe(1.5)
  })

  it('anythingElse_One', () => {
    expect([0.5, 3, 1.1, '', 'fast', null, undefined, NaN, '0.75x'].map(readSpeed)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1])
  })
})

describe('speakingJs', () => {
  it('aRange_TheCallWithItsCfiAndSection', () => {
    expect(speakingJs({ cfi: 'epubcfi(/6/4!/4/2/1:3)', index: 2 })).toBe('window.__fol.speaking("epubcfi(/6/4!/4/2/1:3)", 2)')
  })

  it('aCfiWithQuotes_AStringNeverCode', () => {
    const js = speakingJs({ cfi: 'epubcfi(/6/4!/4[a"),alert(1)//])', index: 0 })
    expect(js).toBe('window.__fol.speaking("epubcfi(/6/4!/4[a\\"),alert(1)//])", 0)')
    // Parses as one string argument.
    const args: unknown[] = []
    new Function('window', js)({ __fol: { speaking: (...a: unknown[]) => args.push(...a) } })
    expect(args).toEqual(['epubcfi(/6/4!/4[a"),alert(1)//])', 0])
  })

  it('noRange_OrNoCfi_OrABadIndex_TheClear', () => {
    expect(speakingJs(null)).toBe('window.__fol.speaking(null)')
    expect(speakingJs({ cfi: null, index: 0 })).toBe('window.__fol.speaking(null)')
    expect(speakingJs({ cfi: 'epubcfi(/6/2)', index: 1.5 })).toBe('window.__fol.speaking(null)')
  })
})

describe('createListener', () => {
  const A = { cfi: 'epubcfi(/6/2!/4/2/1:0)', index: 1 }
  const B = { cfi: 'epubcfi(/6/2!/4/4/1:0)', index: 1 }
  function host() {
    const marks: unknown[] = []
    const h = { speak: vi.fn(async (_t: string) => true), stop: vi.fn(), mark: (at: unknown) => { marks.push(at) } }
    return { h, marks, l: createListener(h) }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('press_MarksTheRangeAndSpeaksTheText', async () => {
    const { h, marks, l } = host()
    l.press(' pond ', A)
    l.phase('loading')
    await tick()
    expect(h.speak).toHaveBeenCalledWith('pond')
    expect(marks).toEqual([A])
    expect(l.speaking('pond')).toBe(true)
  })

  it('playbackEnds_TheMarkGoes', async () => {
    const { marks, l } = host()
    l.press('pond', A)
    l.phase('loading')
    l.phase('playing')
    l.phase('idle')
    await tick()
    expect(marks).toEqual([A, null])
    expect(l.speaking('pond')).toBe(false)
  })

  it('theSameTextPressedAgain_Stops', async () => {
    const { h, marks, l } = host()
    l.press('pond', A)
    l.phase('playing')
    l.press('pond', A)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.speak).toHaveBeenCalledTimes(1)
    l.phase('idle')
    expect(marks).toEqual([A, null])
  })

  it('anotherText_ReplacesIt_NoStop', async () => {
    const { h, marks, l } = host()
    l.press('pond', A)
    l.phase('playing')
    l.press('by the pond', B)
    l.phase('loading')
    await tick()
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.speak).toHaveBeenLastCalledWith('by the pond')
    expect(marks).toEqual([A, B])
    expect(l.speaking('by the pond')).toBe(true)
    expect(l.speaking('pond')).toBe(false)
  })

  it('pressedAgainWhenIdle_SpeaksAgain', async () => {
    const { h, l } = host()
    l.press('pond', A)
    l.phase('playing')
    l.phase('idle')
    l.press('pond', A)
    expect(h.speak).toHaveBeenCalledTimes(2)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('playbackNeverStarted_TheMarkGoes', async () => {
    const { h, marks, l } = host()
    h.speak.mockResolvedValueOnce(false)
    l.press('pond', A)
    await tick()
    expect(marks).toEqual([A, null])
  })

  it('playingBeforeTheHostReportedAPhase_TheMarkStays', async () => {
    const { marks, l } = host()
    l.press('pond', A)
    await tick()
    expect(marks).toEqual([A])
  })

  it('aSupersededStart_LeavesTheNewMark', async () => {
    const { h, marks, l } = host()
    let first!: () => void
    h.speak.mockImplementationOnce(() => new Promise<boolean>((r) => { first = () => r(false) }))
    l.press('pond', A)
    l.press('by the pond', B)
    l.phase('loading')
    first()
    await tick()
    expect(marks).toEqual([A, B])
  })

  it('aThrowingSpeak_TheMarkGoes', async () => {
    const { h, marks, l } = host()
    h.speak.mockRejectedValueOnce(new Error('x'))
    l.press('pond', A)
    await tick()
    expect(marks).toEqual([A, null])
  })

  it('blankText_Nothing', () => {
    const { h, marks, l } = host()
    l.press('  ', A)
    expect(h.speak).not.toHaveBeenCalled()
    expect(marks).toEqual([])
  })
})
