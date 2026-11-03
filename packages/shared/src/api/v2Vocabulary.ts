/**
 * Vocabulary on V2 (#1025 M2.7), for both clients: the card list, saves, edits, deletes and the
 * review queue on `/me/v2/vocabulary/*`, mapped onto the legacy DTOs so the pages and hooks are
 * unchanged. Stats, settings, clusters, lookups and pending words stay legacy whatever the flag (V2
 * holds no such data, ADR-031 D6). The platform gives the id source and a book's current file.
 */
import * as v2Api from './v2'
import type { V2Word } from './v2'
import { clip } from '../reader/v2Locators'
import type { VocabularyWordDto, SaveWordResponseDto, ReviewCardDto, WeeklyProgressDto, SubmitReviewResponse } from '../types/api'

export interface V2VocabularyPlatform {
  /** A v4 uuid. */
  newId(): string
  /** The book's current file id, or null (unknown, or no file). */
  fileIdOf(bookId: string): Promise<string | null>
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

export function createV2Vocabulary(platform: V2VocabularyPlatform) {
  // The card revisions of the last pull: an edit names the one it read.
  const revisions = new Map<string, number>()
  const remember = (w: V2Word) => {
    revisions.set(w.id, w.revision)
    return w
  }

  /** Every live card. ponytail: a full pull per list, no local store (R6). */
  const liveWords = async () => (await v2Api.pullAll<V2Word>('vocabulary')).items.filter((w) => !w.deletedAt).map(remember)

  /** A save from the reader: one card by key (an existing one keeps its id and comes back), plus the sentence as an example. */
  async function saveV2Word(data: V2SaveWord): Promise<SaveWordResponseDto> {
    const sentence = nullable(data.sentence, 1000)
    const bookId = data.userBookId ?? null
    const fileId = bookId ? await platform.fileIdOf(bookId).catch(() => null) : null
    const word = remember(await v2Api.saveWord({
      id: data.id ?? platform.newId(),
      language: data.language,
      word: clip(data.word, 200),
      translation: nullable(data.translation, 500),
      definition: nullable(data.definition, 2000),
      example: sentence ? {
        operationId: data.operationId ?? platform.newId(),
        sentence,
        bookId,
        fileId,
        chapterKey: bookId ? data.chapterId ?? null : null,
        bookTitle: nullable(data.bookTitle, 500),
      } : undefined,
    }))
    return { outcome: 'srs', word: toVocabWord(word), pendingId: null, lookupId: null, tapsRemaining: null, reason: null }
  }

  /** The list page's query, applied to the full pull: stage ('0', '1,2,3'), search, sort, paging. */
  async function getV2Words(params?: { stage?: string; search?: string; sort?: string; limit?: number; offset?: number }): Promise<{ total: number; items: VocabularyWordDto[] }> {
    let items = (await liveWords()).map(toVocabWord)
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
    return (await liveWords()).map((w) => ({ id: w.id, word: w.word, stage: w.stage, translation: w.translation ?? undefined }))
  }

  async function deleteV2Word(id: string): Promise<void> {
    await v2Api.deleteWord(id)
    revisions.delete(id)
  }

  /** An edit on the revision last read; lost to another device's edit, it is applied once more on top. */
  async function updateV2Word(id: string, data: { translation?: string | null; definition?: string | null; onlyIfEmpty?: boolean }): Promise<VocabularyWordDto> {
    const patch = (expectedRevision: number) => v2Api.patchWord(id, {
      expectedRevision,
      ...(data.translation !== undefined && { translation: nullable(data.translation, 500) }),
      ...(data.definition !== undefined && { definition: nullable(data.definition, 2000) }),
    })
    try {
      if (data.onlyIfEmpty) {
        // TR-2: an automatic fill never replaces a translation.
        const card = await v2Api.getWord(id)
        if (card.translation) return toVocabWord(remember(card))
        return toVocabWord(remember(await patch(card.revision)))
      }
      return toVocabWord(remember(await patch(revisions.get(id) ?? remember(await v2Api.getWord(id)).revision)))
    } catch (e) {
      const err = v2Api.v2ErrorOf(e)
      if (err?.code !== 'stale_revision' || err.revision == null) throw e
      return toVocabWord(remember(await patch(err.revision)))
    }
  }

  /** The due cards as flashcards. ponytail: no distractors on V2, so multiple choice has no options. */
  async function getV2ReviewQueue(limit?: number): Promise<{ cards: ReviewCardDto[]; totalDue: number; weeklyProgress: WeeklyProgressDto | null }> {
    const due = (await v2Api.getDue(limit)).map(remember)
    return {
      cards: due.map((w) => ({
        wordId: w.id, word: w.word, translation: w.translation, definition: w.definition,
        reviewMode: 'multiple_choice', blankSentence: null, originalSentence: w.examples[0]?.sentence ?? null,
        bookTitle: w.examples[0]?.bookTitle ?? null, hint: null, explanation: null, isNew: w.stage === 0,
        options: null, correctOptionIndex: null,
      })),
      totalDue: due.length,
      weeklyProgress: null,
    }
  }

  /** One answer; the server schedules it (S3). */
  async function submitV2Review(data: { wordId: string; isCorrect: boolean; responseTimeMs: number; reviewMode?: string }): Promise<SubmitReviewResponse> {
    const { review, word } = await v2Api.recordReview({
      operationId: platform.newId(),
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

  return { saveV2Word, getV2Words, getV2ReaderVocab, deleteV2Word, updateV2Word, getV2ReviewQueue, submitV2Review }
}
