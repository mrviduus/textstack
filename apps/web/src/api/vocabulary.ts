import { createVocabulary, type SelfAssessment, type WordSaveInput } from '@textstack/shared'
import { liveBook, syncStore } from './sync'

// Vocabulary: the shared V2 vocabulary (one copy for web and mobile) with the
// browser's ids, the last library pull's files and this tab's revision cache.
// Made on first use, not on load: the platform (`platform/web.ts`) imports this module, and `./sync` can
// still be loading then (an import cycle through `api/client.ts`), so `syncStore` is not there yet.
type Vocab = ReturnType<typeof createVocabulary>
let made: Vocab | undefined
const vocab = (): Vocab => (made ??= createVocabulary({
  newId: () => crypto.randomUUID(),
  fileIdOf: async (bookId) => (await liveBook(bookId)).currentFile?.id ?? null,
  cards: syncStore.cards,
  epoch: () => syncStore.epoch,
}))

export type {
  VocabularyWordDto as VocabWordDto,
  SaveWordResponseDto as SaveWordResponse,
  ReviewCardDto,
  SelfAssessment,
  SubmitReviewResponse,
} from '@textstack/shared'

/** Web-only fields, never sent: `editionId` rides the offline pending queue, `nativeLanguage` the analytics event. */
export type SaveWordRequest = WordSaveInput & { editionId?: string | null; nativeLanguage?: string | null }

export const saveWord: Vocab['saveWord'] = (...a) => vocab().saveWord(...a)
export const getWords: Vocab['getWords'] = (...a) => vocab().getWords(...a)
export const deleteWord: Vocab['deleteWord'] = (...a) => vocab().deleteWord(...a)
export const deleteAllWords: Vocab['deleteAllWords'] = (...a) => vocab().deleteAllWords(...a)
export const updateWord: Vocab['updateWord'] = (...a) => vocab().updateWord(...a)
export const getReviewQueue: Vocab['getReviewQueue'] = (...a) => vocab().getReviewQueue(...a)
export const restoreWord: Vocab['restoreWord'] = (...a) => vocab().restoreWord(...a)
export const getReaderVocab: Vocab['getReaderVocab'] = (...a) => vocab().getReaderVocab(...a)

/** `selfAssessment` is the review card's answer; the V2 server keeps no copy of it, so it is not sent. */
export const submitReview = (r: Parameters<Vocab['submitReview']>[0] & { selfAssessment?: SelfAssessment }) =>
  vocab().submitReview(r)
