import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useGuestLimits } from '../context/GuestLimitsContext'
import { getReaderVocab, markAsKnown as markAsKnownApi, saveWord, deleteWord as deleteWordApi, updateWord, type SaveWordRequest, type SaveWordResponse, type VocabWordDto } from '../api/vocabulary'
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
import { trackVocabSaved } from '../lib/analytics'
import { takeGuestNudge, type GuestNudge } from '../lib/guestNudge'

// `sentence`: the one the word was saved in, when known (saved this session, or sent by the
// server for a word with no translation). Guards a saved translation against another sense.
export type VocabMap = Map<string, { stage: number; id?: string; translation?: string; sentence?: string; isPending?: boolean }>

export function useReaderVocabulary(bookLanguage?: string, targetLang?: string | null) {
  const { isAuthenticated, isGuest, waitForSession, ensureSession } = useAuth()
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
  const backfillDone = useRef(false)
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
    commitMap(next)
  }, [commitMap])

  // Load vocab from API once a session exists (guest or real). Sentences only when the
  // backfill below will translate into another language — its context, nothing else needs them.
  const includeSentences = !!targetLang && !!bookLanguage && targetLang !== bookLanguage
  useEffect(() => {
    if (!isAuthenticated) {
      commitMap(new Map())
      return
    }
    let cancelled = false
    setLoading(true)
    getReaderVocab(includeSentences)
      .then((words) => {
        if (cancelled) return
        const m: VocabMap = new Map()
        for (const w of words) {
          m.set(normalizeVocabKey(w.word), { stage: w.stage, id: w.id, translation: w.translation, sentence: w.sentence ?? undefined })
        }
        commitMap(m)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isAuthenticated, includeSentences, commitMap])

  // Backfill translations for words missing them
  useEffect(() => {
    if (!targetLang || !bookLanguage || backfillDone.current) return
    if (vocabMap.size === 0 || loading) return

    const missing: { word: string; id?: string; sentence?: string }[] = []
    for (const [key, entry] of vocabMap) {
      // Skip pending entries — their `id` is a local UUID, not a backend row.
      if (entry.isPending) continue
      if (!entry.translation) missing.push({ word: key, id: entry.id, sentence: entry.sentence })
    }
    if (missing.length === 0) return

    backfillDone.current = true
    const lang = bookLanguage
    const target = targetLang

    // Translate in small batches to avoid overwhelming the API
    ;(async () => {
      for (let i = 0; i < missing.length; i++) {
        const { word, id, sentence } = missing[i]
        try {
          // In the stored sentence, so the gloss is the sense the word was saved in.
          const res = await translateWord(word, lang, target, undefined, { sentence })
          const translation = res.translatedText
          if (!translation) continue
          updateMap(m => {
            const entry = m.get(word)
            if (entry) m.set(word, { ...entry, translation })
          })
          if (id) updateWord(id, { translation }).catch(() => {})
        } catch { /* skip */ }
      }
    })()
  }, [vocabMap, loading, targetLang, bookLanguage, updateMap])

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

    for (const p of pending) {
      const key = normalizeVocabKey(p.word)
      const existing = mapRef.current.get(key)
      try {
        const resp = await saveWord({
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
        const saved = resp.word
        if (!saved) {
          // outcome=pending (daily cap hit during flush) → drop local pending, leave map entry.
          // Next reconciler tick will promote it; user won't see the word as "saved" in reader
          // until then, but we also don't want to re-flush it repeatedly.
          continue
        }
        updateMap(m => {
          // Preserve any translation accumulated in map (from translateApi) over backend's null.
          const preserved = m.get(key)?.translation ?? saved.translation ?? p.translation ?? undefined
          m.set(normalizeVocabKey(saved.word), {
            stage: saved.stage,
            id: saved.id,
            translation: preserved ?? undefined,
            sentence: saved.sentence ?? undefined,
          })
        })
      } catch {
        // I4: keep in local, retry on next trigger. Stop iteration to avoid hammering a failing API.
        break
      }
    }
  }, [updateMap])

  const addWord = useCallback(async (req: SaveWordRequest): Promise<SaveWordResponse | null> => {
    // Gate: block first tap until AuthContext has finished bootstrapping (B2).
    await waitForSession()
    // Decided before the save: the 3rd word is the one that mints the guest, so after it the
    // reader IS a guest — but they were never an account, and accounts never get the nudge.
    const isAccount = isAuthRef.current && !isGuestRef.current
    const nudge = () => {
      if (isAccount) return
      const n = takeGuestNudge(mapRef.current.size)
      if (n) setGuestNudge(n)
    }

    // Path A: session exists (guest or real) → direct save, plus any stale pending flush.
    if (isAuthRef.current) {
      // I5: pending из pre-auth периода (напр. юзер сохранил 1-2 слова как anon,
      // потом залогинился на другой странице) — flush перед текущим save.
      await flushPendingIfAny()
      const resp = await saveWord(req)
      trackVocabSaved({ language: req.language, nativeLanguage: req.nativeLanguage ?? undefined, source: 'reader' })
      const saved = resp.word
      if (saved) {
        const key = normalizeVocabKey(saved.word)
        const existing = mapRef.current.get(key)
        if (!(existing && existing.id === saved.id && existing.stage === saved.stage && !existing.isPending)) {
          updateMap(m => m.set(key, {
            stage: saved.stage, id: saved.id,
            translation: existing?.translation || saved.translation || undefined,
            sentence: saved.sentence ?? undefined,
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
    updateMap(m => m.set(normalizeVocabKey(req.word), {
      stage: 0,
      id: pending.id,                // local UUID; replaced with backend id after flush
      translation: req.translation ?? undefined,
      sentence: req.sentence ?? undefined,
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
  }, [waitForSession, ensureSession, updateMap, commitmentThreshold, flushPendingIfAny])

  const markAsKnown = useCallback(async (id: string, word: string) => {
    if (!isAuthenticated) return null
    const updated = await markAsKnownApi(id)
    updateMap(m => m.set(normalizeVocabKey(word), { stage: 4, id: updated.id }))
    emitDataChange('vocabulary')
    return updated
  }, [isAuthenticated, updateMap])

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
  const recordSavedWord = useCallback((dto: VocabWordDto) => {
    const key = normalizeVocabKey(dto.word)
    const existing = mapRef.current.get(key)
    updateMap(m => m.set(key, {
      stage: dto.stage,
      id: dto.id,
      translation: existing?.translation || dto.translation || undefined,
      sentence: dto.sentence ?? undefined,
    }))
  }, [updateMap])

  const updateTranslation = useCallback((word: string, translation: string) => {
    const key = normalizeVocabKey(word)
    const entry = mapRef.current.get(key)
    if (!entry) return
    updateMap(m => m.set(key, { ...entry, translation }))
  }, [updateMap])

  const refreshMarks = useCallback(() => {
    setVocabMap(new Map(mapRef.current))
  }, [])

  return { vocabMap, loading, addWord, markAsKnown, removeWord, updateTranslation, recordSavedWord, refreshMarks, idbUnavailable, dismissIdbUnavailable, guestNudge, dismissGuestNudge }
}
