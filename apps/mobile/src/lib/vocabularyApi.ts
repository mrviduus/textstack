/**
 * The vocabulary API the screens and the reader call: the shared V2 vocabulary (#1025 M2.7; the only store since
 * M6), as on web — the card list, saves, edits, deletes, restores and the review queue.
 */
import { uuid } from 'expo-modules-core'
import { createVocabulary, type WordSaveInput } from '@textstack/shared'
import { v2Book, v2Store, v2Epoch } from './v2'

const v2 = createVocabulary({
  newId: () => uuid.v4(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
  cards: v2Store.cards,
  epoch: v2Epoch,
})

type SaveWord = Omit<WordSaveInput, 'language'> & { language?: string }

export const vocabularyApi = {
  /** `id`/`operationId`: minted once per save, so a retry is the same card and operation. */
  saveWord: (data: SaveWord) => v2.saveWord({ ...data, language: data.language ?? 'en' }),
  getWords: (params?: Parameters<typeof v2.getWords>[0] & { filter?: string }) =>
    v2.getWords({ ...params, stage: params?.stage || params?.filter }),
  getReaderVocab: v2.getReaderVocab,
  updateWord: v2.updateWord,
  deleteWord: v2.deleteWord,
  getReviewQueue: v2.getReviewQueue,
  submitReview: v2.submitReview,
  /** A save answered `deleted` (the reader deleted the word earlier) offers this (#1270). */
  restoreWord: (id: string) => v2.restoreWord(id),
}
