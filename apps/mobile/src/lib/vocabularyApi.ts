/**
 * `@textstack/shared`'s `vocabularyApi`, switched per call to V2 (#1025 M2.7) for the card list,
 * saves, edits, deletes and the review queue — the shared V2 vocabulary, as on web. Stats, settings,
 * clusters, lookups and pending words stay legacy whatever the flag (ADR-031 D6).
 */
import { uuid } from 'expo-modules-core'
import { vocabularyApi as legacy, createV2Vocabulary, type V2SaveWord } from '@textstack/shared'
import { onV2, v2Book } from './v2'

const v2 = createV2Vocabulary({
  newId: () => uuid.v4(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
})

type LegacySave = Parameters<typeof legacy.saveWord>[0]

export const vocabularyApi = {
  ...legacy,
  /** `id`/`operationId`: V2 only — minted once per save, so a retry is the same card and operation. */
  saveWord: async ({ id, operationId, ...data }: LegacySave & Pick<V2SaveWord, 'id' | 'operationId'>) =>
    ((await onV2()) ? v2.saveV2Word({ ...data, language: data.language ?? 'en', id, operationId }) : legacy.saveWord(data)),
  getWords: async (params?: Parameters<typeof legacy.getWords>[0]) =>
    ((await onV2()) ? v2.getV2Words({ ...params, stage: params?.stage || params?.filter }) : legacy.getWords(params)),
  getReaderVocab: async () => ((await onV2()) ? v2.getV2ReaderVocab() : legacy.getReaderVocab()),
  updateWord: async (id: string, data: Parameters<typeof legacy.updateWord>[1]) =>
    ((await onV2()) ? v2.updateV2Word(id, data) : legacy.updateWord(id, data)),
  deleteWord: async (id: string) => ((await onV2()) ? v2.deleteV2Word(id) : legacy.deleteWord(id)),
  getReviewQueue: async (limit?: number, practice?: boolean) =>
    ((await onV2()) ? v2.getV2ReviewQueue(limit, practice) : legacy.getReviewQueue(limit, practice)),
  submitReview: async (data: Parameters<typeof legacy.submitReview>[0]) =>
    ((await onV2()) ? v2.submitV2Review(data) : legacy.submitReview(data)),
}
