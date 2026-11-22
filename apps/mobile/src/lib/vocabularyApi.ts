/**
 * The vocabulary API the screens and the reader call: the shared V2 vocabulary (#1025 M2.7; the only store since
 * M6), as on web — the card list, saves, edits, deletes, restores and the review queue.
 */
import { uuid } from 'expo-modules-core'
import { createVocabulary, type WordSaveInput } from '@textstack/shared'
import { liveBook, syncStore, syncEpoch } from './sync'

const vocabulary = createVocabulary({
  newId: () => uuid.v4(),
  fileIdOf: async (bookId) => (await liveBook(bookId)).currentFile?.id ?? null,
  cards: syncStore.cards,
  epoch: syncEpoch,
})

type SaveWord = Omit<WordSaveInput, 'language'> & { language?: string }

export const vocabularyApi = {
  /** `id`/`operationId`: minted once per save, so a retry is the same card and operation. */
  saveWord: (data: SaveWord) => vocabulary.saveWord({ ...data, language: data.language ?? 'en' }),
  getWords: (params?: Parameters<typeof vocabulary.getWords>[0] & { filter?: string }) =>
    vocabulary.getWords({ ...params, stage: params?.stage || params?.filter }),
  getReaderVocab: vocabulary.getReaderVocab,
  updateWord: vocabulary.updateWord,
  deleteWord: vocabulary.deleteWord,
  getReviewQueue: vocabulary.getReviewQueue,
  submitReview: vocabulary.submitReview,
  /** A save answered `deleted` (the reader deleted the word earlier) offers this (#1270). */
  restoreWord: (id: string) => vocabulary.restoreWord(id),
}
