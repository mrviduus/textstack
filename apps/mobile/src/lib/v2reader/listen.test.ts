import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TTS_VOICES, readSpeed, ttsVoice } from './listen.mjs'

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
