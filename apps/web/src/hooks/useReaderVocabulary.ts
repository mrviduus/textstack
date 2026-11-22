import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useGuestLimits } from '../context/GuestLimitsContext'
import { getReaderVocab, saveWord, deleteWord as deleteWordApi, updateWord, type SaveWordRequest, type SaveWordResponse, type VocabWordDto } from '../api/vocabulary'
import { syncApi } from '@textstack/shared'
import { emitDataChange } from '../lib/dataEvents'
import { translate as translateWord } from '../api/translation'
import {
  addPendingVocabWord,
  listPendingVocabWords,
  countPendingVocabWords,
  deletePendingVocabWord,
  type PendingVocabWord,
} from '../lib/offlineDb'
import { normalizeVocabKey } from '../lib/vocabKey'
import { backfillTranslations, ofBook, wordId } from '../../../../packages/reader/src/vocabWords.mjs'
import { trackVocabSaved } from '../lib/analytics'
import { takeGuestNudge, type GuestNudge } from '../lib/guestNudge'

export type VocabMap = Map<string, { stage: number; id?: string; translation?: string; isPending?: boolean }>

/**
 * The reader's saved words (#1271): the legacy reader's
 * saves, guest queue and mint, with V2's rules on top. The map holds the cards of `marksLanguage` only
 * (vocabWords.mjs `ofBook`; null: a book whose declared language does not read, none); the backfill fills those, once
 * per authenticated load and language (vocabWords.mjs `backfillTranslations`); a guest's nudge counts the whole
 * vocabulary; a flushed queued word of another language is not this book's.
 */
export function useReaderVocabulary(marksLanguage: string | null, targetLang?: string | null) {
  const marksLang = marksLanguage
  /** The language the map is for and the backfill translates from. */
  const mapLang = marksLang
  const takes = useCallback((language: string | null | undefined) => ofBook(language, marksLang), [marksLang])
  const { isAuthenticated, isGuest, waitForSession, ensureSession, user } = useAuth()
  /** #1271 review: the map is the identity's: a guest becoming an account (another user id) loads again. */
  const userId = user?.id ?? null
  /**
   * #1271 review: the identity now, read by every late answer (a save, a flushed word, a recorded card, a backfill
   * write) against the one it was asked under: an answer of another session applies nothing. Anonymous → guest (the
   * third word's mint, mid-save) is the same person; a sign-out or another identity is not (`ours`).
   */
  const idNow = useRef(userId)
  idNow.current = userId
  const ours = (asked: string | null) => asked === null || asked === idNow.current
  /** The native language now: a backfill for another one stops (its words would be written in the old language). */
  const targetNow = useRef(targetLang)
  targetNow.current = targetLang
  const { commitmentThreshold } = useGuestLimits()
  const [vocabMap, setVocabMap] = useState<VocabMap>(new Map())
  const [loading, setLoading] = useState(false)
  // I7: signal for ReaderHighlights to toast when IndexedDB is unavailable
  // (Safari private mode / quota exceeded) so user knows to sign in to save words.
  const [idbUnavailable, setIdbUnavailable] = useState(false)
  const dismissIdbUnavailable = useCallback(() => setIdbUnavailable(false), [])
  // "Create an account" nudge on a non-account reader's 3rd / 10th saved word.
  const [guestNudge, setGuestNudge] = useState<GuestNudge | null>(null)
  const dismissGuestNudge = useCallback(() => setGuestNudge(null), [])
  const mapRef = useRef<VocabMap>(new Map())
  /** The (load, user, native language) whose words were backfilled; '': none. */
  const backfillDone = useRef('')
  /** Bumped by every load (a new identity, language, retry) and at unmount: a backfill of an older one stops. */
  const loadGen = useRef(0)
  /**
   * #1271 review: the whole vocabulary's words (key + language, unfiltered), for a guest's nudge: it counts them all, as
   * legacy does, whatever the map is filtered to.
   */
  const allWords = useRef(new Set<string>())
  const remember = (word: string, language: string | null | undefined) => allWords.current.add(wordId(normalizeVocabKey, word, language))
  /**
   * #1271 review: "already saved" (the auto-save's guard, the popup's ✓): a card of the book's language (the map), or one
   * with no language (the legacy list, V2 down), so no word is saved twice. A card of another language is another word
   * (Android's rule): it does not block.
   */
  const isKnown = useCallback((word: string) =>
    mapRef.current.has(normalizeVocabKey(word)) || allWords.current.has(wordId(normalizeVocabKey, word, null)), [])
  /**
   * The map's changes since the authenticated load in flight started (a save, a restore, a fill), replayed over its words
   * when it commits: its snapshot predates them. Null while no load is in flight.
   */
  const sinceLoad = useRef<((m: VocabMap) => void)[] | null>(null)
  // Keep auth state available inside async callbacks without stale-closure races.
  const isAuthRef = useRef(isAuthenticated)
  isAuthRef.current = isAuthenticated
  const isGuestRef = useRef(isGuest)
  isGuestRef.current = isGuest

  const commitMap = useCallback((map: VocabMap) => {
    mapRef.current = map
    setVocabMap(map)
  }, [])

  const updateMap = useCallback((fn: (draft: VocabMap) => void) => {
    const next = new Map(mapRef.current)
    fn(next)
    sinceLoad.current?.push(fn)
    commitMap(next)
  }, [commitMap])

  // `loaded`: the map holds the reader's saved words (a load succeeded, or there is no session to load for);
  // `loadFailed`: the last load failed, and `retryLoad` starts another. A caller that must not save a word twice
  // (the V2 reader's auto-save, #1270) waits for `loaded`.
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  /**
   * #1271 review: the authenticated load whose words are in (its number and the language it was filtered for), null while
   * none is: the backfill latches on this, never on `loaded` (the no-session branch sets it too), and only for the language
   * the map is for now (a language change in the same commit is not this load's).
   */
  const [authLoad, setAuthLoad] = useState<{ id: number; lang: string | null } | null>(null)
  const loads = useRef(0)
  const alive = useRef(true)
  // Set in the body: StrictMode's dev mount runs the cleanup once, then the effect again.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; loadGen.current++ }
  }, [])
  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), [])

  // Load vocab from API once a session exists (guest or real).
  useEffect(() => {
    loadGen.current++
    // A new identity's (or a retry's) words: the sets start again here, so a save answering meanwhile stays in them.
    allWords.current = new Set()
    if (!isAuthenticated) {
      sinceLoad.current = null
      commitMap(new Map())
      setAuthLoad(null)
      setLoaded(true)
      setLoadFailed(false)
      return
    }
    let cancelled = false
    const load = ++loads.current
    const lang = mapLang
    setAuthLoad(null)
    setLoading(true)
    setLoaded(false)
    setLoadFailed(false)
    const since: ((m: VocabMap) => void)[] = []
    sinceLoad.current = since
    getReaderVocab()
      .then((words) => {
        if (cancelled) return
        const m: VocabMap = new Map()
        for (const w of words) {
          remember(w.word, w.language)
          // Only the book's language's cards (`takes`): a German card is not an English book's saved word, nor filled
          // with a translation from English.
          if (!takes(w.language)) continue
          m.set(normalizeVocabKey(w.word), { stage: w.stage, id: w.id, translation: w.translation })
        }
        // What was saved (or filled, removed) while it loaded, over its older snapshot.
        for (const fn of since) fn(m)
        if (sinceLoad.current === since) sinceLoad.current = null
        commitMap(m)
        setAuthLoad({ id: load, lang })
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isAuthenticated, userId, commitMap, loadAttempt, mapLang, takes])

  // Backfill translations for words missing them: once per authenticated load, over the words it brought, for the
  // language it was filtered for (#1271: once per open). A word saved afterwards gets its translation from the save
  // itself (TR-2), never a second, sentence-less request here. vocabWords.mjs `backfillTranslations`: one card written
  // before the next, a 429 stops it, and so do a newer load (identity, language, retry) and the unmount.
  useEffect(() => {
    // Latched on (load, native language): each load is one identity's; a new native language fills what is still missing.
    if (!targetLang || !authLoad || authLoad.lang !== mapLang || backfillDone.current === `${authLoad.id}|${targetLang}`) return
    backfillDone.current = `${authLoad.id}|${targetLang}`
    const from = authLoad.lang
    const gen = loadGen.current
    const stopped = () => !alive.current || gen !== loadGen.current || targetNow.current !== targetLang
    // Pending entries have a local UUID, not a backend row.
    const missing = [...vocabMap].flatMap(([word, e]) => (!e.isPending && !e.translation && e.id ? [{ id: e.id, word }] : []))
    void backfillTranslations(missing, from, targetLang, {
      translate: (word) => translateWord(word, from!, targetLang).then((r) => r.translatedText || null),
      // The card the server answers with (`onlyIfEmpty` keeps a translation it had): its translation is what the map shows.
      persist: (id, translation) => updateWord(id, { translation, onlyIfEmpty: true }).then((card) => {
        const kept = card?.translation
        if (!kept || stopped()) return
        updateMap((m) => { for (const [k, e] of m) if (e.id === id && !e.translation) m.set(k, { ...e, translation: kept }) })
      }),
      onWord: () => {},
      cancelled: () => stopped(),
    })
  }, [vocabMap, authLoad, targetLang, mapLang, updateMap])

  // I4: flush pending local vocab into backend. Called:
  //   (a) on threshold-crossing after ensureSession succeeds;
  //   (b) pre-save in Path A when session was acquired externally (I5 stale-pending guard).
  // Stops on first failure — remaining pending stay in IndexedDB for next retry.
  const flushPendingIfAny = useCallback(async () => {
    let pending: PendingVocabWord[]
    try {
      pending = await listPendingVocabWords()
    } catch {
      return
    }
    if (pending.length === 0) return
    const asked = idNow.current

    for (const p of pending) {
      const key = normalizeVocabKey(p.word)
      // The map holds the book's language's cards: its entry is this queued word's card only in that language.
      const existing = takes(p.language) ? mapRef.current.get(key) : undefined
      try {
        const resp = await saveWord({
          // V2: the queued save is one operation — its replay names the same card and example.
          id: p.wordId ?? p.id,
          operationId: p.id,
          word: p.word,
          language: p.language,
          // Prefer translation captured locally after pending was created (via updateTranslation).
          translation: existing?.translation ?? p.translation ?? null,
          definition: p.definition ?? null,
          editionId: p.editionId ?? null,
          chapterId: p.chapterId ?? null,
          userBookId: p.userBookId ?? null,
          sentence: p.sentence ?? null,
          bookTitle: p.bookTitle ?? null,
          nativeLanguage: p.nativeLanguage ?? null,
        })
        await deletePendingVocabWord(p.id).catch(() => {})
        // Another session since the flush began: its answers apply nothing here.
        if (!ours(asked)) return
        const saved = resp.outcome === 'deleted' ? null : resp.word
        if (!saved) {
          // outcome=pending (daily cap hit during flush) → drop local pending, leave map entry.
          // Next reconciler tick will promote it; user won't see the word as "saved" in reader
          // until then, but we also don't want to re-flush it repeatedly.
          continue
        }
        remember(saved.word, saved.language ?? p.language)
        // #1271: another book's queued word is not this book's saved word (the V2 reader's map is the book's language).
        if (!takes(saved.language ?? p.language)) continue
        updateMap(m => {
          // Preserve any translation accumulated in map (from translateApi) over backend's null.
          const preserved = m.get(key)?.translation ?? saved.translation ?? p.translation ?? undefined
          m.set(normalizeVocabKey(saved.word), {
            stage: saved.stage,
            id: saved.id,
            translation: preserved ?? undefined,
          })
        })
      } catch (e) {
        // V2 refused this entry for good (a deleted word, a reused operation, a bad payload, a book
        // gone): drop it and go on, so it never blocks the saves behind it.
        const code = syncApi.syncErrorOf(e)?.code
        if (code === 'deleted' || code === 'operation_conflict' || code === 'invalid_payload' || code === 'book_not_found') {
          console.warn('[vocab] queued save dropped:', code, p.word)
          await deletePendingVocabWord(p.id).catch(() => {})
          continue
        }
        // I4: keep in local, retry on next trigger. Stop iteration to avoid hammering a failing API.
        break
      }
    }
  }, [updateMap, takes])

  const addWord = useCallback(async (req: SaveWordRequest): Promise<SaveWordResponse | null> => {
    // Gate: block first tap until AuthContext has finished bootstrapping (B2).
    await waitForSession()
    // Decided before the save: the 3rd word is the one that mints the guest, so after it the
    // reader IS a guest — but they were never an account, and accounts never get the nudge.
    const isAccount = isAuthRef.current && !isGuestRef.current
    const nudge = () => {
      if (isAccount) return
      // The whole vocabulary (legacy counts every card; the V2 map holds the book's language's only).
      const n = takeGuestNudge(allWords.current.size)
      if (n) setGuestNudge(n)
    }

    // Path A: session exists (guest or real) → direct save, plus any stale pending flush.
    if (isAuthRef.current) {
      const asked = idNow.current
      // I5: pending из pre-auth периода (напр. юзер сохранил 1-2 слова как anon,
      // потом залогинился на другой странице) — flush перед текущим save.
      await flushPendingIfAny()
      // Another session since the tap (signed out, another identity while the flush ran): nothing is sent for it.
      if (!ours(asked)) return null
      const resp = await saveWord(req)
      trackVocabSaved({ language: req.language, nativeLanguage: req.nativeLanguage ?? undefined, source: 'reader' })
      // Another session since the save was asked: its answer applies nothing here.
      if (!ours(asked)) return resp
      const saved = resp.outcome === 'deleted' ? null : resp.word
      if (saved) {
        const key = normalizeVocabKey(saved.word)
        const existing = mapRef.current.get(key)
        remember(saved.word, saved.language ?? req.language)
        if (takes(saved.language ?? req.language) && !(existing && existing.id === saved.id && existing.stage === saved.stage && !existing.isPending)) {
          updateMap(m => m.set(key, {
            stage: saved.stage, id: saved.id,
            translation: existing?.translation || saved.translation || undefined,
          }))
        }
        // Notify the Vocabulary page (and any other vocab consumer) so it
        // refreshes without remount. No-op on this page since useReader
        // doesn't subscribe to its own emissions.
        emitDataChange('vocabulary')
        nudge()
      }
      return resp
    }

    // Path B: anonymous → accumulate locally until commitment threshold.
    const pending: PendingVocabWord = {
      id: crypto.randomUUID(),
      word: req.word,
      language: req.language,
      translation: req.translation ?? null,
      definition: req.definition ?? null,
      editionId: req.editionId ?? null,
      chapterId: req.chapterId ?? null,
      userBookId: req.userBookId ?? null,
      sentence: req.sentence ?? null,
      bookTitle: req.bookTitle ?? null,
      nativeLanguage: req.nativeLanguage ?? null,
      createdAt: Date.now(),
    }
    try {
      await addPendingVocabWord(pending)
    } catch {
      // I7: IndexedDB unavailable (Safari private / storage full). Surface to caller
      // via `idbUnavailable` so ReaderHighlights can toast "sign in to save words".
      setIdbUnavailable(true)
      return null
    }
    // I8: synthetic map entry so WordPopup can show "saved" state immediately.
    // `isPending` flag prevents backfill from hitting backend with a local UUID.
    remember(req.word, req.language)
    updateMap(m => m.set(normalizeVocabKey(req.word), {
      stage: 0,
      id: pending.id,                // local UUID; replaced with backend id after flush
      translation: req.translation ?? undefined,
      isPending: true,
    }))
    // Track anonymous saves too — measures guest engagement before commitment threshold.
    trackVocabSaved({ language: req.language, nativeLanguage: req.nativeLanguage ?? undefined, source: 'reader' })

    // I2: threshold check — cross → create guest, flush everything.
    let count = 0
    try {
      count = await countPendingVocabWords()
    } catch {
      count = 0
    }
    if (count >= commitmentThreshold) {
      await ensureSession()
      if (isAuthRef.current) {
        await flushPendingIfAny()
      }
      // I7: ensureSession fail → pending остаётся, следующий tap снова триггерит.
    }
    nudge()

    // Path B returns null — caller (ReaderHighlights) tolerates null result.
    return null
  }, [waitForSession, ensureSession, updateMap, commitmentThreshold, flushPendingIfAny, takes])

  const removeWord = useCallback(async (id: string, word: string) => {
    // A pending word lives only in IndexedDB under a local id: delete it there,
    // or the guest mint's flush would still save it to the account.
    if (mapRef.current.get(normalizeVocabKey(word))?.isPending) {
      await deletePendingVocabWord(id).catch(() => {})
    } else if (isAuthenticated) {
      await deleteWordApi(id)
    }
    updateMap(m => m.delete(normalizeVocabKey(word)))
    emitDataChange('vocabulary')
  }, [isAuthenticated, updateMap])

  // External insert path for flows that create a VocabularyWord outside of
  // `addWord` (e.g. F1 "Add anyway" which promotes a WordLookup server-side).
  // Mirrors the Path-A merge logic so the reader shows the saved state without
  // waiting for a full vocab refresh.
  /** `asked`: the identity the caller's request was made under (`identity()` before it): another one's card applies nothing. */
  const recordSavedWord = useCallback((dto: VocabWordDto, asked: string | null = idNow.current) => {
    if (!ours(asked)) return
    const key = normalizeVocabKey(dto.word)
    const existing = mapRef.current.get(key)
    remember(dto.word, dto.language)
    if (!takes(dto.language)) return
    updateMap(m => m.set(key, {
      stage: dto.stage,
      id: dto.id,
      translation: existing?.translation || dto.translation || undefined,
    }))
  }, [updateMap, takes])

  /** TR-2: the bubble's automatic path — fills an UNTRANSLATED saved word (map + PATCH), and never
   *  changes an existing translation. Replacing one is only ever `replaceTranslation` (TR-3). */
  const fillingRef = useRef<Set<string>>(new Set())
  const updateTranslation = useCallback(async (word: string, translation: string) => {
    const key = normalizeVocabKey(word)
    const entry = mapRef.current.get(key)
    if (!entry || entry.translation) return
    // No backend row yet (pending / unsaved): local only — the flush sends it with the save.
    if (!entry.id || entry.isPending) {
      updateMap(m => m.set(key, { ...entry, translation }))
      return
    }
    if (fillingRef.current.has(entry.id)) return
    fillingRef.current.add(entry.id)
    const asked = idNow.current
    try {
      // The map follows the server: a translation stored elsewhere wins over ours; a failed PATCH
      // leaves the word unfilled. Another session's answer applies nothing (#1271).
      const stored = (await updateWord(entry.id, { translation, onlyIfEmpty: true }))?.translation
      if (stored && ours(asked)) updateMap(m => { const e = m.get(key); if (e) m.set(key, { ...e, translation: stored }) })
    } catch { /* stays unfilled */ } finally {
      fillingRef.current.delete(entry.id)
    }
  }, [updateMap])

  /** TR-3: the reader tapped "Use this translation" — an explicit PATCH, then the map follows. */
  const replaceTranslation = useCallback(async (word: string, translation: string) => {
    const key = normalizeVocabKey(word)
    const entry = mapRef.current.get(key)
    if (!entry?.id || entry.isPending) return
    await updateWord(entry.id, { translation })
    updateMap(m => { const e = m.get(key); if (e) m.set(key, { ...e, translation }) })
  }, [updateMap])

  const refreshMarks = useCallback(() => {
    setVocabMap(new Map(mapRef.current))
  }, [])

  /** The identity a request is made under, for `recordSavedWord`'s `asked`. */
  const identity = useCallback(() => idNow.current, [])
  return { vocabMap, isKnown, identity, loading, loaded, loadFailed, retryLoad, addWord, removeWord, updateTranslation, replaceTranslation, recordSavedWord, refreshMarks, idbUnavailable, dismissIdbUnavailable, guestNudge, dismissGuestNudge }
}
