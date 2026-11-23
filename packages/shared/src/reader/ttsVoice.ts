/**
 * #1347: `/tts` answers 422 when no voice speaks the language (TtsEndpoints, #1334). That holds for the session, so
 * the language is remembered and both reader hosts hide Listen for it: no retry, no failure toast.
 */
const voiceless = new Set<string>()

/** A `/tts` answer for `lang`: true when it is the 422 (no voice), and `lang` is remembered. */
export function noteTtsStatus(lang: string, status: number): boolean {
  if (status !== 422) return false
  voiceless.add(lang)
  return true
}

/** False once `/tts` said no voice speaks `lang` (this session); true before, whatever else failed. */
export function ttsHasVoice(lang: string): boolean {
  return !voiceless.has(lang)
}
