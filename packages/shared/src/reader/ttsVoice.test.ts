import { describe, it, expect } from 'vitest'
import { noteTtsStatus, ttsHasVoice } from './ttsVoice'

describe('ttsVoice', () => {
  it('noteTtsStatus_422_LanguageLosesListenForTheSession', () => {
    expect(noteTtsStatus('xx', 422)).toBe(true)
    expect(ttsHasVoice('xx')).toBe(false)
  })

  it('noteTtsStatus_OtherFailure_ListenStays', () => {
    expect(noteTtsStatus('de', 502)).toBe(false)
    expect(noteTtsStatus('de', 429)).toBe(false)
    expect(ttsHasVoice('de')).toBe(true)
  })
})
