import { createVocabulary, type SelfAssessment, type WordSaveInput } from '@textstack/shared'
import { liveBook, syncStore } from './sync'

// Vocabulary: the shared V2 vocabulary (one copy for web and mobile) with the
// browser's ids, the last library pull's files and this tab's revision cache.
const vocab = createVocabulary({
  newId: () => crypto.randomUUID(),
  fileIdOf: async (bookId) => (await liveBook(bookId)).currentFile?.id ?? null,
  cards: syncStore.cards,
  epoch: () => syncStore.epoch,
})

export type {
  VocabularyWordDto as VocabWordDto,
  SaveWordResponseDto as SaveWordResponse,
  ReviewCardDto,
  SelfAssessment,
  SubmitReviewResponse,
} from '@textstack/shared'

/** Web-only fields, never sent: `editionId` rides the offline pending queue, `nativeLanguage` the analytics event. */
export type SaveWordRequest = WordSaveInput & { editionId?: string | null; nativeLanguage?: string | null }

export const { saveWord, getWords, deleteWord, deleteAllWords, updateWord, getReviewQueue, restoreWord, getReaderVocab } = vocab

/** `selfAssessment` is the review card's answer; the V2 server keeps no copy of it, so it is not sent. */
export const submitReview = (r: Parameters<typeof vocab.submitReview>[0] & { selfAssessment?: SelfAssessment }) =>
  vocab.submitReview(r)
