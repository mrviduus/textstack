import { describe, expect, it, vi } from 'vitest'
import { createListener, createSpeedChoice, readSpeed, speakingJs, spokenOf, ttsLang } from './listen.mjs'

// #1272: the language a book is spoken in, the speed, and Listen's press / mark rule, on both hosts.

describe('ttsLang', () => {
  it('aLanguage_ItsCode', () => {
    expect(ttsLang('de', 'en')).toBe('de')
    expect(ttsLang('pt', 'en')).toBe('pt')
  })

  it('aRegionOrScript_TheLanguageOnly_OneCacheEntryPerLanguage', () => {
    expect(['pt-BR', 'de_AT', ' FR-CA ', 'zh-Hant-TW', 'en-GB'].map((l) => ttsLang(l, 'en'))).toEqual(['pt', 'de', 'fr', 'zh', 'en'])
  })

  it('threeLetterCodes_BothForms_Folded', () => {
    const pairs: [string, string][] = [
      ['deu', 'de'], ['ger', 'de'], ['fra', 'fr'], ['fre', 'fr'], ['ron', 'ro'], ['rum', 'ro'], ['hin', 'hi'],
      ['vie', 'vi'], ['ind', 'id'], ['cat', 'ca'], ['bul', 'bg'], ['hrv', 'hr'], ['srp', 'sr'], ['slk', 'sk'],
      ['slo', 'sk'], ['lit', 'lt'], ['lav', 'lv'], ['est', 'et'], ['slv', 'sl'], ['fas', 'fa'], ['per', 'fa'],
      ['tha', 'th'], ['ces', 'cs'], ['cze', 'cs'], ['ell', 'el'], ['gre', 'el'], ['nld', 'nl'], ['dut', 'nl'],
      ['zho', 'zh'], ['chi', 'zh'], ['msa', 'ms'], ['may', 'ms'], ['por-BR', 'pt'],
    ]
    expect(pairs.map(([l]) => ttsLang(l, 'en'))).toEqual(pairs.map(([, c]) => c))
  })

  it('norwegian_AllForms_TheServersNo', () => {
    expect(['nb', 'nn', 'no', 'nob', 'nno', 'nor', 'nb-NO'].map((l) => ttsLang(l, 'en'))).toEqual(['no', 'no', 'no', 'no', 'no', 'no', 'no'])
  })

  it('tagalog_Filipino_TheEdgeVoicesCode', () => {
    expect(['tl', 'tgl', 'fil', 'tl-PH'].map((l) => ttsLang(l, 'en'))).toEqual(['fil', 'fil', 'fil', 'fil'])
  })

  it('deprecatedCodes_Folded', () => {
    expect([ttsLang('iw', 'en'), ttsLang('in', 'en')]).toEqual(['he', 'id'])
  })

  it('anUnlistedLanguage_ItsOwnCode_NeverEnglish', () => {
    expect(ttsLang('sw', 'en')).toBe('sw')
    expect(ttsLang('xyz', 'en')).toBe('xyz')
  })

  it('aCodeThatNamesNoLanguage_TheFallback', () => {
    expect(['und', 'mul', 'zxx', 'mis', 'UND', 'und-Latn'].map((l) => ttsLang(l, 'es'))).toEqual(['es', 'es', 'es', 'es', 'es', 'es'])
  })

  it('noLanguageOrNoTag_TheFallback', () => {
    expect(ttsLang('', 'es')).toBe('es')
    expect(ttsLang(undefined, 'en-US')).toBe('en')
    expect(ttsLang('12', 'it')).toBe('it')
    expect(ttsLang('<b>', 'it')).toBe('it')
    expect(ttsLang('english', 'it')).toBe('it')
  })

  it('ukrainian_NoListen', () => {
    expect(['uk', 'uk-UA', 'ukr'].map((l) => ttsLang(l, 'en'))).toEqual([null, null, null])
    expect(ttsLang('', 'uk')).toBeNull()
  })

  it('nothingReadsAsALanguage_NoListen', () => {
    expect(ttsLang('', '')).toBeNull()
    expect(ttsLang('und', 'zxx')).toBeNull()
    expect(ttsLang(42, null)).toBeNull()
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

describe('createSpeedChoice', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('theStoredSpeed_Shown', async () => {
    const show = vi.fn()
    createSpeedChoice({ load: async () => '1.5', save: () => {}, show })
    await tick()
    expect(show).toHaveBeenLastCalledWith(1.5)
  })

  it('aPickBeforeTheStoredOneIsRead_Wins', async () => {
    let answer!: (v: string) => void
    const show = vi.fn()
    const save = vi.fn()
    const pick = createSpeedChoice({ load: () => new Promise<string>((r) => { answer = r }), save, show })
    pick(2)
    await tick()
    answer('0.75')
    await tick()
    expect(show.mock.calls.map((c) => c[0])).toEqual([2])
    expect(save).toHaveBeenCalledWith('2')
  })

  it('aFailedRead_TheDefault', async () => {
    const show = vi.fn()
    createSpeedChoice({ load: async () => { throw new Error('io') }, save: () => {}, show })
    await tick()
    expect(show).not.toHaveBeenCalled()
  })
})

describe('spokenOf', () => {
  const rect = { x: 0, y: 0, w: 1, h: 1 }
  it('aWordOrASelection_ItsTextAndRange', () => {
    expect(spokenOf({ kind: 'word', index: 2, word: 'pond', sentence: 's', cfi: 'epubcfi(/6/2)', rect })).toEqual({ text: 'pond', at: { cfi: 'epubcfi(/6/2)', index: 2 } })
    expect(spokenOf({ kind: 'selection', index: 1, text: 'by the pond', sentence: 's', cfi: null, rect, tooLong: false })).toEqual({ text: 'by the pond', at: { cfi: null, index: 1 } })
  })

  it('anythingElse_Null', () => {
    expect([spokenOf({ kind: 'highlight', id: 'x', rect, x: 0, y: 0 }), spokenOf(null), spokenOf(undefined)]).toEqual([null, null, null])
  })
})

describe('speakingJs', () => {
  it('aRange_TheCallWithItsCfiAndSection', () => {
    expect(speakingJs({ cfi: 'epubcfi(/6/4!/4/2/1:3)', index: 2 })).toBe('window.__fol.speaking("epubcfi(/6/4!/4/2/1:3)", 2)')
  })

  it('aCfiWithQuotes_AStringNeverCode', () => {
    const js = speakingJs({ cfi: 'epubcfi(/6/4!/4[a"),alert(1)//])', index: 0 })
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
  /** A host whose speak resolves when the test says; `done` kept per call. */
  function host() {
    const marks: unknown[] = []
    const calls: { text: string; done: (failed?: boolean) => void; resolve: (played: boolean) => void }[] = []
    const h = {
      speak: vi.fn((text: string, done: (failed?: boolean) => void) => new Promise<boolean>((resolve) => { calls.push({ text, done, resolve }) })),
      stop: vi.fn(),
      mark: (at: unknown) => { marks.push(at) },
      changed: vi.fn(),
      failed: vi.fn(),
    }
    return { h, marks, calls, l: createListener(h) }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('press_LoadingAtOnce_MarksTheRange_SpeaksTheText', () => {
    const { h, marks, l } = host()
    l.press({ text: ' pond ', at: A })
    expect(l.state({ text: 'pond', at: A })).toBe('loading')
    expect(h.speak).toHaveBeenCalledWith('pond', expect.any(Function))
    expect(marks).toEqual([A])
    expect(h.changed).toHaveBeenCalled()
  })

  it('aQuickSecondPressWhileLoading_StopsIt_NeverASecondStart', () => {
    const { h, marks, l } = host()
    l.press({ text: 'pond', at: A })
    l.press({ text: 'pond', at: A })
    expect(h.speak).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(l.state({ text: 'pond', at: A })).toBe('idle')
    expect(marks).toEqual([A, null])
  })

  it('played_Playing_ThenDone_Idle_TheMarkGoes', async () => {
    const { calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].resolve(true)
    await tick()
    expect(l.state({ text: 'pond', at: A })).toBe('playing')
    calls[0].done()
    expect(l.state({ text: 'pond', at: A })).toBe('idle')
    expect(marks).toEqual([A, null])
  })

  it('nothingPlayed_Idle_TheMarkGoes_Failed', async () => {
    const { h, calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].resolve(false)
    await tick()
    expect(l.state({ text: 'pond', at: A })).toBe('idle')
    expect(marks).toEqual([A, null])
    expect(h.failed).toHaveBeenCalledTimes(1)
  })

  it('aThrowingSpeak_Failed', async () => {
    const { h, marks, l } = host()
    h.speak.mockRejectedValueOnce(new Error('x'))
    l.press({ text: 'pond', at: A })
    await tick()
    expect(marks).toEqual([A, null])
    expect(h.failed).toHaveBeenCalledTimes(1)
  })

  it('pressedWhilePlaying_Stops_NotAFailure', async () => {
    const { h, calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].resolve(true)
    await tick()
    l.press({ text: 'pond', at: A })
    calls[0].done()
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([A, null])
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('theSameWordElsewhere_SpeaksThere_NoStop', () => {
    const { h, marks, l } = host()
    l.press({ text: 'the', at: A })
    l.press({ text: 'the', at: B })
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.speak).toHaveBeenCalledTimes(2)
    expect(marks).toEqual([A, B])
    expect(l.state({ text: 'the', at: B })).toBe('loading')
    expect(l.state({ text: 'the', at: A })).toBe('idle')
  })

  it('anotherText_ReplacesIt_TheOldOnesEndChangesNothing', async () => {
    const { h, calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    l.press({ text: 'by the pond', at: B })
    calls[0].resolve(false)
    calls[0].done()
    await tick()
    expect(h.failed).not.toHaveBeenCalled()
    expect(l.state({ text: 'by the pond', at: B })).toBe('loading')
    expect(marks).toEqual([A, B])
  })

  it('theHostSaysItFailed_ThenFalse_OneFailure', async () => {
    // A hook ends a failed playback (done(true)) before its promise answers false.
    const { h, calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].done(true)
    calls[0].resolve(false)
    await tick()
    expect(h.failed).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([A, null])
  })

  it('theHostCancelledIt_ThenFalse_NotAFailure', async () => {
    // A host-side cancel (the mobile player unmounting: a newer request id, then done(false)): no toast elsewhere.
    const { h, calls, marks, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].done(false)
    calls[0].resolve(false)
    await tick()
    expect(h.failed).not.toHaveBeenCalled()
    expect(marks).toEqual([A, null])
  })

  it('aSynchronousThrow_AFailure', async () => {
    const { h, marks, l } = host()
    h.speak.mockImplementationOnce(() => { throw new Error('sync') })
    expect(() => l.press({ text: 'pond', at: A })).not.toThrow()
    await tick()
    expect(h.failed).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([A, null])
    expect(l.state({ text: 'pond', at: A })).toBe('idle')
  })

  it('follow_ThePopupThatStartedItStillOpen_KeepsIt', () => {
    const { h, l } = host()
    l.press({ text: 'pond', at: A })
    l.follow({ text: 'pond', at: A })
    expect(h.stop).not.toHaveBeenCalled()
    expect(l.state({ text: 'pond', at: A })).toBe('loading')
  })

  it('follow_ItsPopupClosedOrAnotherOpen_StopsIt_TheMarkGoes', () => {
    for (const open of [null, { text: 'pond', at: B }, { text: 'lake', at: A }]) {
      const { h, marks, l } = host()
      l.press({ text: 'pond', at: A })
      l.follow(open)
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(marks).toEqual([A, null])
      expect(h.failed).not.toHaveBeenCalled()
    }
  })

  it('follow_NothingSpeaking_Nothing', () => {
    const { h, l } = host()
    l.follow(null)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('stoppedThenResolvedFalse_NotAFailure', async () => {
    const { h, calls, l } = host()
    l.press({ text: 'pond', at: A })
    l.stop()
    calls[0].resolve(false)
    await tick()
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('aLateResolveAfterDone_StaysIdle', async () => {
    const { calls, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].done()
    calls[0].resolve(true)
    await tick()
    expect(l.state({ text: 'pond', at: A })).toBe('idle')
  })

  it('pressedAgainWhenIdle_SpeaksAgain', async () => {
    const { h, calls, l } = host()
    l.press({ text: 'pond', at: A })
    calls[0].resolve(true)
    await tick()
    calls[0].done()
    l.press({ text: 'pond', at: A })
    expect(h.speak).toHaveBeenCalledTimes(2)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('stop_EndsWhatPlays_NothingWhenIdle', () => {
    const { h, marks, l } = host()
    l.stop()
    expect(h.stop).not.toHaveBeenCalled()
    l.press({ text: 'pond', at: A })
    l.stop()
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(marks).toEqual([A, null])
  })

  it('noRange_SpokenUnmarked', () => {
    const { marks, l } = host()
    l.press({ text: 'pond', at: { cfi: null, index: 0 } })
    expect(marks).toEqual([{ cfi: null, index: 0 }])
    expect(l.state({ text: 'pond', at: { cfi: null, index: 0 } })).toBe('loading')
  })

  it('blankText_Nothing', () => {
    const { h, marks, l } = host()
    l.press({ text: '  ', at: A })
    expect(h.speak).not.toHaveBeenCalled()
    expect(marks).toEqual([])
  })
})
