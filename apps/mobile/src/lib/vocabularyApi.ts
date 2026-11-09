/**
 * `@textstack/shared`'s `vocabularyApi`, switched per call to V2 (#1025 M2.7) for the card list,
 * saves, edits, deletes and the review queue — the shared V2 vocabulary, as on web. Stats, settings,
 * clusters, lookups and pending words stay legacy whatever the flag (ADR-031 D6).
 */
import { uuid } from 'expo-modules-core'
import { vocabularyApi as legacy, createV2Vocabulary, type V2SaveWord } from '@textstack/shared'
import { switched, v2Book, v2Store, v2Epoch, whileCurrent } from './v2'

const v2 = createV2Vocabulary({
  newId: () => uuid.v4(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
  revisions: v2Store.revisions,
  epoch: v2Epoch,
})

type LegacySave = Parameters<typeof legacy.saveWord>[0]

export const vocabularyApi = {
  ...legacy,
  /** `id`/`operationId`: V2 only — minted once per save, so a retry is the same card and operation. */
  saveWord: switched(
    ({ id, operationId, ...data }: LegacySave & Pick<V2SaveWord, 'id' | 'operationId'>) =>
      v2.saveV2Word({ ...data, language: data.language ?? 'en', id, operationId }),
    ({ id: _id, operationId: _op, ...data }: LegacySave & Pick<V2SaveWord, 'id' | 'operationId'>) => legacy.saveWord(data),
  ),
  // Reads answered after a sign-out are empty, as every v2.ts read (#1151).
  getWords: switched(
    async (params?: Parameters<typeof legacy.getWords>[0]) =>
      (await whileCurrent(v2.getV2Words({ ...params, stage: params?.stage || params?.filter }))) ?? { total: 0, items: [] },
    legacy.getWords,
  ),
  getReaderVocab: switched(async () => (await whileCurrent(v2.getV2ReaderVocab())) ?? [], legacy.getReaderVocab),
  updateWord: switched(v2.updateV2Word, legacy.updateWord),
  deleteWord: switched(v2.deleteV2Word, legacy.deleteWord),
  getReviewQueue: switched(
    async (limit?: number, includeAll?: boolean) =>
      (await whileCurrent(v2.getV2ReviewQueue(limit, includeAll))) ?? { cards: [], totalDue: 0, weeklyProgress: null },
    legacy.getReviewQueue,
  ),
  submitReview: switched(v2.submitV2Review, legacy.submitReview),
}
