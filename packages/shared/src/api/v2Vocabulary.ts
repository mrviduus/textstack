/**
 * Vocabulary on V2 (#1025 M2.7), for both clients: the card list, saves, edits, deletes, restores
 * and the review queue on `/me/v2/vocabulary/*`, mapped onto the legacy DTOs so the pages and hooks
 * are unchanged. Stats, settings, clusters, lookups and pending words stay legacy whatever the flag
 * (V2 holds no such data, ADR-031 D6). The platform gives the id source, a book's current file and
 * the session's revision cache.
 */
import * as v2Api from './v2'
import type { V2Word } from './v2'
import { clip } from '../reader/textAnchor'
import type { VocabularyWordDto, SaveWordResponseDto, ReviewCardDto, WeeklyProgressDto, SubmitReviewResponse } from '../types/api'

export interface V2VocabularyPlatform {
  /** A v4 uuid. */
  newId(): string
  /** The book's current file id, or null (unknown, or no file). */
  fileIdOf(bookId: string): Promise<string | null>
  /** The cards last read or written, by id (a revision to write on; a practice answer's card) — the session's store, emptied with it. */
  cards: Map<string, V2Word>
  /**
   * The app's store epoch, bumped when `cards` is emptied (sign-out, another account). A call that
   * outlives a bump remembers, writes and returns nothing of the previous account's (#1151).
   */
  epoch: () => number
}

export interface V2SaveWord {
  word: string
  language: string
  translation?: string | null
  definition?: string | null
  chapterId?: string | null
  userBookId?: string | null
  sentence?: string | null
  bookTitle?: string | null
  /** The caller's when it queued the save offline, so a replay is the same card and operation (PDD rule 13). */
  id?: string
  operationId?: string
}

export function toVocabWord(w: V2Word): VocabularyWordDto {
  const example = w.examples[0]
  return {
    id: w.id,
    word: w.word,
    language: w.language,
    translation: w.translation,
    definition: w.definition,
    editionId: null,
    chapterId: example?.chapterKey ?? null,
    userBookId: example?.bookId ?? null,
    sentence: example?.sentence ?? null,
    bookTitle: example?.bookTitle ?? null,
    hint: null,
    stage: w.stage,
    intervalDays: w.intervalDays,
    consecutiveCorrect: w.consecutiveCorrect,
    nextReviewAt: w.nextReviewAt,
    lastReviewedAt: w.lastReviewedAt,
    totalReviews: 0,
    correctReviews: 0,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  }
}

const nullable = (text: string | null | undefined, max: number) => (text?.trim() ? clip(text, max) : null)

const response = (outcome: 'srs' | 'deleted', w: V2Word): SaveWordResponseDto =>
  ({ outcome, word: toVocabWord(w), pendingId: null, lookupId: null, tapsRemaining: null, reason: null })

export function createV2Vocabulary({ newId, fileIdOf, cards, epoch }: V2VocabularyPlatform) {
  /**
   * One call's view of the session: `remember` caches a card, `check` refuses a server write
   * (`SessionChangedError`) and `stale` empties a read, once the epoch moved since the call started.
   */
  const session = (started = epoch()) => {
    const stale = () => epoch() !== started
    return {
      stale,
      remember: (w: V2Word) => {
        if (!stale()) cards.set(w.id, w)
        return w
      },
      check: () => {
        if (stale()) throw new v2Api.SessionChangedError()
      },
    }
  }

  /** Every live card. ponytail: a full pull per list, no local store (R6). */
  const liveWords = async ({ remember } = session()) => (await v2Api.pullFeed<V2Word>('vocabulary')).items.filter((w) => !w.deletedAt).map(remember)

  /**
   * A save from the reader: one card by key (an existing one keeps its id and comes back), plus the
   * sentence as an example on a user book. A word the reader deleted earlier answers `deleted`
   * with the tombstone, and `restoreV2Word` brings it back.
   */
  async function saveV2Word(data: V2SaveWord): Promise<SaveWordResponseDto> {
    const { remember, check } = session()
    const sentence = nullable(data.sentence, 1000)
    const bookId = data.userBookId ?? null
    const fileId = bookId ? await fileIdOf(bookId).catch(() => null) : null
    check()
    try {
      return response('srs', remember(await v2Api.saveWord({
        id: data.id ?? newId(),
        language: data.language,
        word: clip(data.word, 200),
        translation: nullable(data.translation, 500),
        definition: nullable(data.definition, 2000),
        example: sentence ? {
          operationId: data.operationId ?? newId(),
          sentence,
          bookId,
          fileId,
          chapterKey: bookId ? data.chapterId ?? null : null,
          bookTitle: nullable(data.bookTitle, 500),
        } : undefined,
      })))
    } catch (e) {
      const err = v2Api.v2ErrorOf(e)
      if (err?.code !== 'deleted' || !err.current) throw e
      return response('deleted', remember(err.current as V2Word))
    }
  }

  /** Bring a deleted card back, on the revision its tombstone carried. */
  async function restoreV2Word(id: string): Promise<VocabularyWordDto> {
    const { remember, check } = session()
    const revision = cards.get(id)?.revision ?? remember(await v2Api.getWord(id)).revision
    check()
    return toVocabWord(remember(await v2Api.restoreWord(id, revision)))
  }

  async function deleteV2Word(id: string): Promise<void> {
    await v2Api.deleteWord(id)
    cards.delete(id)
  }

  /** "Delete all" as one DELETE per live card. ponytail: per-item requests; a bulk route if libraries grow. */
  async function deleteAllV2Words(): Promise<{ deleted: number }> {
    const s = session()
    const live = await liveWords(s)
    for (const w of live) {
      s.check()
      await deleteV2Word(w.id)
    }
    return { deleted: live.length }
  }

  /** The list page's query, applied to the full pull: stage ('0', '1,2,3'), search, sort, paging. */
  async function getV2Words(params?: { stage?: string; search?: string; sort?: string; limit?: number; offset?: number }): Promise<{ total: number; items: VocabularyWordDto[] }> {
    const s = session()
    const live = await liveWords(s)
    if (s.stale()) return { total: 0, items: [] }
    let items = live.map(toVocabWord)
    if (params?.stage) {
      const stages = params.stage.split(',').map(Number)
      items = items.filter((w) => stages.includes(w.stage))
    }
    const q = params?.search?.trim().toLowerCase()
    if (q) items = items.filter((w) => w.word.toLowerCase().includes(q) || w.translation?.toLowerCase().includes(q))
    const by: Record<string, (a: VocabularyWordDto, b: VocabularyWordDto) => number> = {
      alphabetical: (a, b) => a.word.localeCompare(b.word),
      due: (a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt),
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
    }
    items.sort(by[params?.sort ?? 'recent'] ?? by.recent)
    const offset = params?.offset ?? 0
    return { total: items.length, items: items.slice(offset, params?.limit ? offset + params.limit : undefined) }
  }

  async function getV2ReaderVocab(): Promise<{ id: string; word: string; stage: number; translation?: string }[]> {
    const s = session()
    const live = await liveWords(s)
    return s.stale() ? [] : live.map((w) => ({ id: w.id, word: w.word, stage: w.stage, translation: w.translation ?? undefined }))
  }

  /** An edit on the revision last read; lost to another device's edit, it is decided again on what that card holds. */
  async function updateV2Word(id: string, data: { translation?: string | null; definition?: string | null; onlyIfEmpty?: boolean }): Promise<VocabularyWordDto> {
    const { remember, check } = session()
    const patch = (expectedRevision: number) => (check(), v2Api.patchWord(id, {
      expectedRevision,
      ...(data.translation !== undefined && { translation: nullable(data.translation, 500) }),
      ...(data.definition !== undefined && { definition: nullable(data.definition, 2000) }),
    }))
    let card: V2Word | null = data.onlyIfEmpty ? remember(await v2Api.getWord(id)) : null
    for (let retried = false; ; retried = true) {
      // TR-2: an automatic fill never replaces a translation — checked against every card it would land on.
      if (data.onlyIfEmpty && card?.translation) return toVocabWord(card)
      try {
        return toVocabWord(remember(await patch(card?.revision ?? cards.get(id)?.revision ?? remember(await v2Api.getWord(id)).revision)))
      } catch (e) {
        const err = v2Api.v2ErrorOf(e)
        if (retried || err?.code !== 'stale_revision' || !err.current) throw e
        card = remember(err.current as V2Word) // another device edited it: decide again on what it holds now
      }
    }
  }

  /**
   * The due cards as flashcards; with `includeAll` (practice) and nothing due, the cards nearest to
   * due, as legacy's practice falls back. ponytail: flashcards only — multiple choice needs
   * distractors, a server feature V2 does not have (ADR-031 D6); the fallback sorts the full pull.
   */
  async function getV2ReviewQueue(limit?: number, includeAll?: boolean): Promise<{ cards: ReviewCardDto[]; totalDue: number; weeklyProgress: WeeklyProgressDto | null }> {
    const s = session()
    let due = (await v2Api.getDue(limit)).map(s.remember)
    const totalDue = due.length
    if (!due.length && includeAll) {
      due = (await liveWords(s)).filter((w) => !w.retiredAt)
        .sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt))
        .slice(0, limit ?? 20)
    }
    if (s.stale()) return { cards: [], totalDue: 0, weeklyProgress: null }
    return {
      cards: due.map((w) => ({
        wordId: w.id, word: w.word, translation: w.translation, definition: w.definition,
        reviewMode: 'flashcard', blankSentence: null, originalSentence: w.examples[0]?.sentence ?? null,
        bookTitle: w.examples[0]?.bookTitle ?? null, hint: null, explanation: null, isNew: w.stage === 0,
        options: null, correctOptionIndex: null,
      })),
      totalDue,
      weeklyProgress: null,
    }
  }

  /**
   * One answer; the server schedules it (S3). `operationId` is the answer's: a retry of it sends the
   * same one. A practice answer is not posted — V2 has no practice, and a posted review moves the
   * card's schedule (legacy's practice leaves it alone) — and reports the card unchanged.
   */
  async function submitV2Review(data: { wordId: string; isCorrect: boolean; responseTimeMs: number; reviewMode?: string; operationId?: string; isPractice?: boolean }): Promise<SubmitReviewResponse> {
    const { remember } = session()
    if (data.isPractice) {
      const w = cards.get(data.wordId)
      return {
        wordId: data.wordId, previousStage: w?.stage ?? 0, newStage: w?.stage ?? 0, stageChanged: false,
        nextIntervalDays: w?.intervalDays ?? 0, nextReviewAt: w?.nextReviewAt ?? new Date().toISOString(), totalReviews: 0, correctReviews: 0,
      }
    }
    const { review, word } = await v2Api.recordReview({
      operationId: data.operationId ?? newId(),
      wordId: data.wordId,
      reviewMode: data.reviewMode || 'review',
      isCorrect: data.isCorrect,
      responseTimeMs: Math.max(0, Math.round(data.responseTimeMs)),
      clientRecordedAt: new Date().toISOString(),
    })
    remember(word)
    return {
      wordId: word.id,
      previousStage: review.stageBefore,
      newStage: review.stageAfter,
      stageChanged: review.stageBefore !== review.stageAfter,
      nextIntervalDays: word.intervalDays,
      nextReviewAt: word.nextReviewAt,
      totalReviews: 0,
      correctReviews: 0,
    }
  }

  return {
    saveV2Word, restoreV2Word, deleteV2Word, deleteAllV2Words, getV2Words, getV2ReaderVocab, updateV2Word,
    getV2ReviewQueue, submitV2Review,
  }
}
