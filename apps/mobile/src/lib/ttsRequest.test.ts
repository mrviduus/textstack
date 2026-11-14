import { describe, it, expect } from 'vitest'
import { ttsRequestDecision, TtsPhase } from './ttsRequest'

const SENTENCE = 'It is a truth universally acknowledged, that a single man must be in want of a wife.'

describe('ttsRequestDecision', () => {
  it('starts when nothing is speaking', () => {
    expect(ttsRequestDecision({
      phase: 'idle', currentText: null, requestedText: SENTENCE,
    })).toBe('start')
  })

  it('stops when the press lands on what is already playing', () => {
    expect(ttsRequestDecision({
      phase: 'playing', currentText: SENTENCE, requestedText: SENTENCE,
    })).toBe('stop')
  })

  it('plays the sentence when a word is already playing', () => {
    // The reported bug: tap a word, hear it, select a sentence, press Listen —
    // and get silence, because the press was read as "stop" purely from the
    // fact that sound was coming out.
    expect(ttsRequestDecision({
      phase: 'playing', currentText: 'acknowledged', requestedText: SENTENCE,
    })).toBe('start')
  })

  it('supersedes a download that has not made a sound yet', () => {
    expect(ttsRequestDecision({
      phase: 'loading', currentText: 'acknowledged', requestedText: SENTENCE,
    })).toBe('start')
  })

  it('cancels its own download when pressed again during the wait', () => {
    // The impatient second press. It must stop, not queue a duplicate fetch.
    expect(ttsRequestDecision({
      phase: 'loading', currentText: SENTENCE, requestedText: SENTENCE,
    })).toBe('stop')
  })

  it('treats surrounding whitespace as the same passage', () => {
    // The selection bridge trims; the speak path trims. A press must not read
    // as a new passage just because one side kept a trailing space.
    expect(ttsRequestDecision({
      phase: 'playing', currentText: SENTENCE, requestedText: `  ${SENTENCE}\n`,
    })).toBe('stop')
  })

  it('ignores an empty request', () => {
    for (const phase of ['idle', 'loading', 'playing'] as TtsPhase[]) {
      expect(ttsRequestDecision({
        phase, currentText: SENTENCE, requestedText: '   ',
      })).toBe('ignore')
    }
  })

  it('starts when the phase says busy but the text was lost', () => {
    // Defensive: a null currentText while non-idle should not read as a match
    // and silently swallow the press.
    expect(ttsRequestDecision({
      phase: 'playing', currentText: null, requestedText: SENTENCE,
    })).toBe('start')
  })
})
