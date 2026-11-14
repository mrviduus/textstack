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

/**
 * ISO 639-2 codes (bibliographic and terminology forms) and deprecated or macro two-letter codes → the ISO 639-1
 * code the server keys its voices by. Norwegian Bokmål and Nynorsk are the server's `no`; Tagalog is Filipino (`fil`,
 * the Edge voices' `fil-PH`: `tl` has none and would fall to en-US).
 */
const FOLD = {
  eng: 'en', rus: 'ru', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', ita: 'it', por: 'pt', pol: 'pl',
  nld: 'nl', dut: 'nl', tur: 'tr', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', ara: 'ar', hin: 'hi', ces: 'cs',
  cze: 'cs', slk: 'sk', slo: 'sk', ron: 'ro', rum: 'ro', hun: 'hu', swe: 'sv', nor: 'no', nob: 'no', nno: 'no',
  nb: 'no', nn: 'no', dan: 'da', fin: 'fi', ell: 'el', gre: 'el', heb: 'he', iw: 'he', ind: 'id', in: 'id',
  vie: 'vi', tha: 'th', bul: 'bg', hrv: 'hr', srp: 'sr', lit: 'lt', lav: 'lv', est: 'et', slv: 'sl', cat: 'ca',
  fas: 'fa', per: 'fa', ukr: 'uk', msa: 'ms', may: 'ms', isl: 'is', ice: 'is', eus: 'eu', baq: 'eu', glg: 'gl',
  sqi: 'sq', alb: 'sq', mkd: 'mk', mac: 'mk', hye: 'hy', arm: 'hy', kat: 'ka', geo: 'ka', cym: 'cy', wel: 'cy',
  gle: 'ga', bel: 'be', kaz: 'kk', ben: 'bn', urd: 'ur', tam: 'ta', tel: 'te', mar: 'mr', swa: 'sw', afr: 'af',
  tgl: 'fil', tl: 'fil', aze: 'az', uzb: 'uz', mon: 'mn', nep: 'ne', sin: 'si', khm: 'km', lao: 'lo', mya: 'my', bur: 'my',
  amh: 'am', som: 'so', zul: 'zu', pus: 'ps', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa', jav: 'jv', sun: 'su',
}
/** ISO 639 codes that name no language: undetermined, multiple, no linguistic content, uncoded. */
const NOT_A_LANGUAGE = new Set(['und', 'mul', 'zxx', 'mis'])

/** A tag's language (`pt` of `pt-BR`, `de` of `deu_AT`), or null: not a tag, or one that names no language. */
function language(tag) {
  if (typeof tag !== 'string') return null
  const t = tag.trim()
  if (!/^[a-z]{2,3}([-_][a-z0-9]{1,8})*$/i.test(t)) return null
  const p = t.split(/[-_]/)[0].toLowerCase()
  const code = FOLD[p] ?? p
  return NOT_A_LANGUAGE.has(code) ? null : code
}

/**
 * The `lang` sent to `/tts` (#1272; the legacy mobile player's too): the language of `lang` (its primary subtag, a
 * three-letter code folded: `pt-BR` → `pt`, `deu` → `de`, `nb` → `no`), else the fallback's (the hosts': the
 * translation's, web `en`, Android the app's language). Only the language: the server picks the voice by it
 * (`TtsConfiguration.DefaultVoices`), and one spelling per language keeps one cache entry. A language is never turned
 * into English (the legacy mobile defect: `uk` and `de` books read by an en-US voice).
 * Null: no Listen. Ukrainian (the server refuses it, #103), or nothing that reads as a language.
 */
export function ttsLang(lang, fallback) {
  const code = language(lang) ?? language(fallback)
  return code && code !== 'uk' ? code : null
}

/**
 * Listen's one rule, both hosts. `speak(text, done)` starts the host's playback: resolves true once it plays, false
 * when nothing did; `done(failed)` is called once when that playback ends for any reason, `failed` true when it
 * could not play (a fetch or player error), false when it ended (played out, stopped, superseded, the host gone).
 * `stop()` ends playback. `mark(at | null)` asks the page to mark a range (`speaking`) or clear it. `changed()`
 * re-renders the host (its buttons read `state`); `failed()` says the speech could not play. `press`, `state` and
 * `follow` take what `spokenOf` makes of the host's open word popup or toolbar.
 *
 * The listener owns the phase, set synchronously: `loading` at the press, `playing` once `speak` resolves true, `idle`
 * at `done`, a false answer or a stop. A press on the range speaking (its text, CFI and section) stops it, also while
 * loading (the button says so); any other press replaces it. `follow(open)`: the host's word popup or toolbar now
 * shows `open` (`{ text, at }`, or null): a speech that is not its own stops. The mark is drawn at the press and goes
 * with the playback. A failure is `done(true)`, a throw or a false answer with no `done` before it (no audio module).
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
  /** `mine` is over: a failure is said once, whatever says it first. */
  const finish = (mine, failure) => {
    end(mine)
    if (mine.ended) return
    mine.ended = true
    if (failure) failed()
  }
  const listener = {
    press(spoken) {
      const t = typeof spoken?.text === 'string' ? spoken.text.trim() : ''
      if (!t) return
      const at = spoken.at
      if (phase !== 'idle' && same(t, at)) return listener.stop()
      if (current) current.ended = true
      const mine = (current = { text: t, cfi: at?.cfi ?? null, index: at?.index ?? null, ended: false })
      phase = 'loading'
      mark(at ?? null)
      changed()
      let started
      try {
        started = Promise.resolve(speak(t, (failure) => finish(mine, failure === true)))
      } catch {
        started = Promise.resolve(false)
      }
      started.catch(() => false).then((played) => {
        if (played === false) return finish(mine, true)
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
    follow(open) {
      if (current && !(open && same(typeof open.text === 'string' ? open.text.trim() : '', open.at))) listener.stop()
    },
    /** What the button for that text and range shows: `idle` unless it is the one fetched or played. */
    state: (spoken) => (typeof spoken?.text === 'string' && same(spoken.text.trim(), spoken.at) ? phase : 'idle'),
  }
  return listener
}

/**
 * What Listen speaks for the word popup or selection toolbar open (`popupStep`'s): its text and range, or null for
 * anything else (a highlight's editor, nothing open).
 */
export function spokenOf(popup) {
  if (popup?.kind === 'word') return { text: popup.word, at: { cfi: popup.cfi, index: popup.index } }
  if (popup?.kind === 'selection') return { text: popup.text, at: { cfi: popup.cfi, index: popup.index } }
  return null
}

/**
 * The Android host's injected call for the mark (`injectJavaScript`): the range spoken, or null when the speech ended
 * or stopped. The CFI came from the page (untrusted, through readWord / readSelection): a JSON string here, never code.
 */
export function speakingJs(at) {
  const cfi = at && typeof at.cfi === 'string' && Number.isInteger(at.index) ? at.cfi : null
  return cfi === null ? 'window.__fol.speaking(null)' : `window.__fol.speaking(${JSON.stringify(cfi)}, ${at.index})`
}
