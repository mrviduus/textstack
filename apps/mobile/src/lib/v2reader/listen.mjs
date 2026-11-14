// Listen (#1272): pure, the page and both hosts. The host fetches and plays the audio (the page has no network) and
// asks the page to mark the range it speaks (`speaking`); this module is what both hosts send and when.

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
 * A speed kept in an async store (Android's AsyncStorage): `load()` the stored value, `save(string)`, `show(speed)`
 * the one in effect. Returns the reader's pick. A pick made before the stored value is read wins: the late read is
 * dropped, never written over the pick.
 */
export function createSpeedChoice({ load, save, show }) {
  let picked = false
  Promise.resolve().then(load).then((v) => { if (!picked) show(readSpeed(v)) }, () => {})
  return (v) => {
    picked = true
    const s = readSpeed(v)
    show(s)
    save(String(s))
  }
}

/** ISO 639-2 codes books carry (`deu`, `fre`) → their two-letter code. */
const ALPHA3 = {
  eng: 'en', rus: 'ru', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', pol: 'pl',
  nld: 'nl', dut: 'nl', tur: 'tr', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', ces: 'cs', cze: 'cs', swe: 'sv',
  ukr: 'uk', nob: 'no', nor: 'no', ell: 'el', gre: 'el', heb: 'he', ara: 'ar', fin: 'fi', dan: 'da', hun: 'hu',
}
/** ISO 639 codes that name no language: undetermined, multiple, no linguistic content, uncoded. */
const NOT_A_LANGUAGE = new Set(['und', 'mul', 'zxx', 'mis'])

/** A tag as a language tag (`pt-BR`, `de-AT` of `deu_AT`), or null: not a tag, or one that names no language. */
function languageTag(tag) {
  if (typeof tag !== 'string') return null
  const t = tag.trim()
  if (!/^[a-z]{2,3}([-_][a-z0-9]{1,8})*$/i.test(t)) return null
  const [p, ...rest] = t.split(/[-_]/)
  const code = ALPHA3[p.toLowerCase()] ?? p.toLowerCase()
  return NOT_A_LANGUAGE.has(code) ? null : [code, ...rest].join('-')
}

/**
 * The `lang` a host sends `/tts` for a book (#1272): `opened.lang` as written (its region kept, a three-letter code
 * folded: `pt-BR`, `deu` → `de`), else the host's fallback (the translation's: web `en`, Android the app's language).
 * The server picks the voice (`TtsConfiguration.DefaultVoices`, by the language part). A language is never turned
 * into English (the legacy mobile defect: `uk` and `de` books read by an en-US voice).
 * Null: no Listen. Ukrainian (the server refuses it, #103), or nothing that reads as a language.
 */
export function ttsLang(lang, fallback) {
  const tag = languageTag(lang) ?? languageTag(fallback)
  return tag && tag.split('-')[0] !== 'uk' ? tag : null
}

/**
 * Listen's one rule, both hosts. `speak(text, done)` starts the host's playback: resolves true once it plays, false
 * when nothing did (failed, superseded, no audio module); `done()` is called once when that playback ends for any
 * reason. `stop()` ends playback. `mark(at | null)` asks the page to mark a range (`speaking`) or clear it.
 * `changed()` re-renders the host (its buttons read `state`); `failed()` says the speech could not play.
 *
 * The listener owns the phase, set synchronously: `loading` at the press, `playing` once `speak` resolves true, `idle`
 * when it resolves false, at `done`, or at a stop. A press on the range speaking (its text, CFI and section) stops it,
 * also while loading (the button says so: a spinner, "tap to cancel"); any other press replaces it. The mark is drawn
 * at the press and goes with the playback. `speak` resolving false is a failure unless the listener ended it itself
 * (a stop, or another press replacing it): a host stops through `stop()` here, never its player directly.
 */
export function createListener({ speak, stop, mark, changed = () => {}, failed = () => {} }) {
  let current = null
  let phase = 'idle'
  const same = (t, at) => current && current.text === t && current.cfi === (at?.cfi ?? null) && current.index === (at?.index ?? null)
  const end = (mine) => {
    if (current !== mine) return
    current = null
    phase = 'idle'
    mark(null)
    changed()
  }
  return {
    press(text, at) {
      const t = typeof text === 'string' ? text.trim() : ''
      if (!t) return
      if (phase !== 'idle' && same(t, at)) return this.stop()
      if (current) current.ended = true
      const mine = (current = { text: t, cfi: at?.cfi ?? null, index: at?.index ?? null, ended: false })
      phase = 'loading'
      mark(at ?? null)
      changed()
      Promise.resolve(speak(t, () => end(mine))).catch(() => false).then((played) => {
        if (played === false) {
          end(mine)
          if (!mine.ended) failed()
          return
        }
        if (current !== mine || phase !== 'loading') return
        phase = 'playing'
        changed()
      })
    },
    stop() {
      const mine = current
      if (!mine) return
      mine.ended = true
      end(mine)
      stop()
    },
    /** What the button for that text and range shows: `idle` unless it is the one fetched or played. */
    state: (text, at) => (typeof text === 'string' && same(text.trim(), at) ? phase : 'idle'),
  }
}

/**
 * The Android host's injected call for the mark (`injectJavaScript`): the range spoken, or null when the speech ended
 * or stopped. The CFI came from the page (untrusted, through readWord / readSelection): a JSON string here, never code.
 */
export function speakingJs(at) {
  const cfi = at && typeof at.cfi === 'string' && Number.isInteger(at.index) ? at.cfi : null
  return cfi === null ? 'window.__fol.speaking(null)' : `window.__fol.speaking(${JSON.stringify(cfi)}, ${at.index})`
}
