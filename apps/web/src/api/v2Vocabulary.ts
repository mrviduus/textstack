/**
 * Vocabulary on V2 (#1025 M2.7): the card list, saves, edits, deletes and the review queue on
 * `/me/v2/vocabulary/*`, mapped onto the legacy DTOs so the pages and hooks are unchanged. Stats,
 * settings, clusters, lookups and pending words stay legacy whatever the flag (V2 holds no such data,
 * ADR-031 D6).
 */
import { v2Api, type V2Word } from '@textstack/shared'
import { clip } from '@textstack/shared'
import { v2Book, pullFeed, v2Store } from './v2'
import type {
  VocabWordDto, SaveWordRequest, SaveWordResponse, UpdateWordRequest, ReviewQueueResponse,
  SubmitReviewRequest, SubmitReviewResponse, ReaderVocabWordDto,
} from './vocabulary'

const remember = (w: V2Word) => {
  v2Store.revisions.set(w.id, w.revision)
  return w
}

export function toVocabWord(w: V2Word): VocabWordDto {
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

/** Every live card. ponytail: a full pull per list, no local store (R6). */
async function liveWords(): Promise<V2Word[]> {
  return (await pullFeed<V2Word>('vocabulary')).items.filter((w) => !w.deletedAt).map(remember)
}

const nullable = (text: string | null | undefined, max: number) => (text?.trim() ? clip(text, max) : null)

/**
 * A save from the reader: one card by key (an existing one keeps its id and comes back), plus the
 * sentence as an example on a user book. `id` and `operationId` are the caller's when it queued
 * the save offline, so a replay is the same operation (PDD rule 13); minted here otherwise.
 */
export async function saveV2Word(data: SaveWordRequest & { id?: string; operationId?: string }): Promise<SaveWordResponse> {
  const sentence = nullable(data.sentence, 1000)
  const bookId = data.userBookId ?? null
  const fileId = bookId ? (await v2Book(bookId).catch(() => null))?.currentFile?.id ?? null : null
  let saved: V2Word
  try {
    saved = await v2Api.saveWord({
    id: data.id ?? crypto.randomUUID(),
    language: data.language,
    word: clip(data.word, 200),
    translation: nullable(data.translation, 500),
    definition: nullable(data.definition, 2000),
    example: sentence ? {
      operationId: data.operationId ?? crypto.randomUUID(),
      sentence,
      bookId,
      fileId,
      chapterKey: bookId ? data.chapterId ?? null : null,
      bookTitle: nullable(data.bookTitle, 500),
    } : undefined,
    })
  } catch (e) {
    // The reader deleted this word earlier: say so, and offer the restore (`restoreV2Word`).
    const err = v2Api.v2ErrorOf(e)
    if (err?.code !== 'deleted' || !err.current) throw e
    return { outcome: 'deleted', word: toVocabWord(remember(err.current as V2Word)), pendingId: null, lookupId: null, tapsRemaining: null, reason: null }
  }
  return { outcome: 'srs', word: toVocabWord(remember(saved)), pendingId: null, lookupId: null, tapsRemaining: null, reason: null }
}

/** Bring a deleted card back, on the revision its tombstone carried. */
export async function restoreV2Word(id: string): Promise<VocabWordDto> {
  const revision = v2Store.revisions.get(id) ?? remember(await v2Api.getWord(id)).revision
  return toVocabWord(remember(await v2Api.restoreWord(id, revision)))
}

/** "Delete all" as one DELETE per live card. ponytail: per-item requests; a bulk route if libraries grow. */
export async function deleteAllV2Words(): Promise<{ deleted: number }> {
  const live = await liveWords()
  for (const w of live) await deleteV2Word(w.id)
  return { deleted: live.length }
}

/** The list page's query, applied to the full pull: stage ('0', '1,2,3'), search, sort, paging. */
export async function getV2Words(params?: { stage?: string; search?: string; sort?: string; limit?: number; offset?: number }): Promise<{ total: number; items: VocabWordDto[] }> {
  let items = (await liveWords()).map(toVocabWord)
  if (params?.stage) {
    const stages = params.stage.split(',').map(Number)
    items = items.filter((w) => stages.includes(w.stage))
  }
  const q = params?.search?.trim().toLowerCase()
  if (q) items = items.filter((w) => w.word.toLowerCase().includes(q) || w.translation?.toLowerCase().includes(q))
  const by: Record<string, (a: VocabWordDto, b: VocabWordDto) => number> = {
    alphabetical: (a, b) => a.word.localeCompare(b.word),
    due: (a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt),
    recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
  }
  items.sort(by[params?.sort ?? 'recent'] ?? by.recent)
  const offset = params?.offset ?? 0
  return { total: items.length, items: items.slice(offset, params?.limit ? offset + params.limit : undefined) }
}

export async function getV2ReaderVocab(): Promise<ReaderVocabWordDto[]> {
  return (await liveWords()).map((w) => ({ id: w.id, word: w.word, stage: w.stage, translation: w.translation ?? undefined }))
}

export async function deleteV2Word(id: string): Promise<void> {
  await v2Api.deleteWord(id)
  v2Store.revisions.delete(id)
}

/** An edit on the revision last read; lost to another device's edit, it is applied once more on top. */
export async function updateV2Word(id: string, data: UpdateWordRequest): Promise<VocabWordDto> {
  const patch = (expectedRevision: number) => v2Api.patchWord(id, {
    expectedRevision,
    ...(data.translation !== undefined && { translation: nullable(data.translation, 500) }),
    ...(data.definition !== undefined && { definition: nullable(data.definition, 2000) }),
  })
  let card: V2Word | null = data.onlyIfEmpty ? remember(await v2Api.getWord(id)) : null
  for (let retried = false; ; retried = true) {
    // TR-2: an automatic fill never replaces a translation — checked against every card it would land on.
    if (data.onlyIfEmpty && card?.translation) return toVocabWord(card)
    try {
      return toVocabWord(remember(await patch(card?.revision ?? v2Store.revisions.get(id) ?? remember(await v2Api.getWord(id)).revision)))
    } catch (e) {
      const err = v2Api.v2ErrorOf(e)
      if (retried || err?.code !== 'stale_revision' || !err.current) throw e
      card = remember(err.current as V2Word) // another device edited it: decide again on what it holds now
    }
  }
}

/**
 * The due cards as flashcards; with `includeAll` and nothing due, the cards nearest to due (as
 * legacy's practice falls back). ponytail: flashcards only — multiple choice needs distractors,
 * a server feature V2 does not have (ADR-031 D6); the fallback sorts the full pull client-side.
 */
export async function getV2ReviewQueue(limit?: number, includeAll?: boolean): Promise<ReviewQueueResponse> {
  let due = (await v2Api.getDue(limit)).map(remember)
  const totalDue = due.length
  if (!due.length && includeAll) {
    due = (await liveWords()).filter((w) => !w.retiredAt)
      .sort((a, b) => a.nextReviewAt.localeCompare(b.nextReviewAt))
      .slice(0, limit ?? 20)
  }
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

/** One answer; the server schedules it (S3). `operationId` is the answer's: a retry of it sends the same one. */
export async function submitV2Review(data: SubmitReviewRequest & { reviewMode?: string; operationId?: string }): Promise<SubmitReviewResponse> {
  const { review, word } = await v2Api.recordReview({
    operationId: data.operationId ?? crypto.randomUUID(),
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
