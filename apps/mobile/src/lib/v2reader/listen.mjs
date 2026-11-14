// Listen (#1272): pure, the page and both hosts. The host fetches and plays the audio (the page has no network) and
// asks the page to mark the range it speaks (`speaking`); this module is what both hosts send and how it is drawn.

/** The spoken range's underline (the page's `speaking`): no highlight colour, so it never reads as one. */
export const SPOKEN_FILL = '#7c3aed'

/** The legacy readers' speeds; 1 unless the reader chose another. */
export const TTS_SPEEDS = [0.75, 1, 1.25, 1.5, 2]
/** Where each host keeps the chosen speed (localStorage / AsyncStorage), as its number's string. */
export const TTS_SPEED_KEY = 'v2reader.ttsSpeed'
/** A stored or chosen speed (a number, or its string): one of TTS_SPEEDS, else 1. */
export function readSpeed(v) {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return TTS_SPEEDS.includes(n) ? n : 1
}

/**
 * A language's voice, the server's own defaults (`TtsConfiguration.DefaultVoices`; listen.test.ts holds the two
 * equal). Sent explicitly so the voice never depends on the server's voice list being loaded.
 */
export const TTS_VOICES = {
  en: 'en-US-AriaNeural', ru: 'ru-RU-SvetlanaNeural', es: 'es-ES-ElviraNeural', fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural', it: 'it-IT-ElsaNeural', pt: 'pt-BR-FranciscaNeural', pl: 'pl-PL-ZofiaNeural',
  nl: 'nl-NL-ColetteNeural', tr: 'tr-TR-EmelNeural', ja: 'ja-JP-NanamiNeural', ko: 'ko-KR-SunHiNeural',
  zh: 'zh-CN-XiaoxiaoNeural', ar: 'ar-SA-ZariyahNeural', hi: 'hi-IN-SwaraNeural', cs: 'cs-CZ-VlastaNeural',
  sk: 'sk-SK-ViktoriaNeural', ro: 'ro-RO-AlinaNeural', hu: 'hu-HU-NoemiNeural', sv: 'sv-SE-SofieNeural',
  no: 'nb-NO-PernilleNeural', da: 'da-DK-ChristelNeural', fi: 'fi-FI-NooraNeural', el: 'el-GR-AthinaNeural',
  he: 'he-IL-HilaNeural', id: 'id-ID-GadisNeural', vi: 'vi-VN-HoaiMyNeural', th: 'th-TH-PremwadeeNeural',
  bg: 'bg-BG-KalinaNeural', hr: 'hr-HR-GabrijelaNeural', sr: 'sr-RS-SophieNeural', lt: 'lt-LT-OnaNeural',
  lv: 'lv-LV-EveritaNeural', et: 'et-EE-AnuNeural', sl: 'sl-SI-PetraNeural', ca: 'ca-ES-JoanaNeural',
  fa: 'fa-IR-DilaraNeural',
}

/** ISO 639-2 codes books carry (`deu`, `fre`) → their two-letter code. */
const ALPHA3 = {
  eng: 'en', rus: 'ru', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', pol: 'pl',
  nld: 'nl', dut: 'nl', tur: 'tr', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', ces: 'cs', cze: 'cs', swe: 'sv',
  ukr: 'uk', nob: 'no', nor: 'no', ell: 'el', gre: 'el', heb: 'he', ara: 'ar', fin: 'fi', dan: 'da', hun: 'hu',
}

/** A tag's language as two (or an unknown three) letters, or null when it is no language tag. */
function primary(tag) {
  if (typeof tag !== 'string') return null
  const p = tag.trim().split(/[-_]/)[0].toLowerCase()
  return /^[a-z]{2,3}$/.test(p) ? ALPHA3[p] ?? p : null
}

/**
 * What a host sends `/tts` for a book (#1272): `opened.lang` as written (a region, a three-letter code: `pt-BR`,
 * `deu`), else the host's fallback (the translation's: web `en`, Android the app's language). `{ lang, voice }`:
 * a language the server knows gets its voice; another goes as its own code with no voice (the server's default for
 * it). A language never becomes English (the legacy mobile defect: `uk` and `de` books read by an en-US voice).
 * Null: no Listen. Ukrainian (the server refuses it, #103) or nothing that reads as a language.
 */
export function ttsVoice(lang, fallback) {
  const code = primary(lang) ?? primary(fallback)
  if (!code || code === 'uk') return null
  return { lang: code, voice: TTS_VOICES[code] ?? null }
}
