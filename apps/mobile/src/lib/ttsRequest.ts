/**
 * What a press of a speak button should do.
 *
 * The reader's Listen button used to branch on one boolean — "is something
 * playing" — and stop whenever it was true. That is right for the button that
 * started the sound and wrong for every other one. A reader who tapped a word,
 * heard it, then selected a sentence and pressed Listen got silence: the press
 * was read as "stop the word", and only a second press started the sentence.
 * Whether a press means stop or start depends on *which* text is playing, not
 * on whether anything is.
 *
 * The other half is the gap before sound. Fetching the audio takes about a
 * second on a first play, and nothing on screen said so, so the natural second
 * press landed while the first was still downloading — and cancelled it. That
 * is why a `loading` phase exists here rather than being folded into `idle`:
 * the UI has to be able to show that the press registered.
 *
 * Pure on purpose — the reader's speech path can only be exercised on a device,
 * so the part that decides is kept where a test can reach it.
 */

/** Where playback is right now. `loading` is fetching audio, before any sound. */
export type TtsPhase = 'idle' | 'loading' | 'playing'

export interface TtsRequestInput {
  phase: TtsPhase
  /** Text being fetched or played. Null when `phase` is 'idle'. */
  currentText: string | null
  /** Text of the button that was just pressed. */
  requestedText: string
}

export type TtsRequestDecision =
  /** Play `requestedText`, superseding anything already in flight. */
  | 'start'
  /** Stop — the press was on whatever is already speaking. */
  | 'stop'
  /** Nothing to say. */
  | 'ignore'

export function ttsRequestDecision(s: TtsRequestInput): TtsRequestDecision {
  const requested = s.requestedText.trim()
  if (!requested) return 'ignore'
  if (s.phase === 'idle') return 'start'
  // Same passage → the press means "I've heard enough". Different passage →
  // the reader is asking for the new one, not to silence the old one.
  return requested === (s.currentText ?? '').trim() ? 'stop' : 'start'
}
