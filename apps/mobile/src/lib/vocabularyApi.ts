/**
 * `@textstack/shared`'s `vocabularyApi`, switched per call to V2 (#1025 M2.7) for the card list,
 * saves, edits, deletes and the review queue — the shared V2 vocabulary, as on web. Stats, settings,
 * clusters, lookups and pending words stay legacy whatever the flag (ADR-031 D6).
 */
import { uuid } from 'expo-modules-core'
import { vocabularyApi as legacy, createV2Vocabulary, type V2SaveWord } from '@textstack/shared'
import { switched, v2Book, v2Store, v2Epoch } from './v2'

const v2 = createV2Vocabulary({
  newId: () => uuid.v4(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
  cards: v2Store.cards,
  epoch: v2Epoch,
})

type LegacySave = Parameters<typeof legacy.saveWord>[0]

/**
 * #1271 review: the route a save, edit or restore actually took, kept on its answer and on the card in it (an object
 * the caller holds): the V2 reader makes a local row only from a V2 card, decided by the call itself, never by asking
 * the probe again afterwards. Undefined for an answer this module did not route (a promote is always legacy).
 */
const routes = new WeakMap<object, 'v2' | 'legacy'>()
export const routeOf = (answer: unknown): 'v2' | 'legacy' | undefined =>
  answer && typeof answer === 'object' ? routes.get(answer) : undefined
const via = (route: 'v2' | 'legacy') => <T>(answer: T): T => {
  if (answer && typeof answer === 'object') {
    routes.set(answer, route)
    const card = (answer as { word?: unknown }).word
    if (card && typeof card === 'object') routes.set(card, route)
  }
  return answer
}

export const vocabularyApi = {
  ...legacy,
  /** `id`/`operationId`: V2 only — minted once per save, so a retry is the same card and operation. */
  saveWord: switched(
    ({ id, operationId, ...data }: LegacySave & Pick<V2SaveWord, 'id' | 'operationId'>) =>
      v2.saveV2Word({ ...data, language: data.language ?? 'en', id, operationId }).then(via('v2')),
    ({ id: _id, operationId: _op, ...data }: LegacySave & Pick<V2SaveWord, 'id' | 'operationId'>) => legacy.saveWord(data).then(via('legacy')),
  ),
  getWords: switched(
    (params?: Parameters<typeof legacy.getWords>[0]) => v2.getV2Words({ ...params, stage: params?.stage || params?.filter }),
    legacy.getWords,
  ),
  getReaderVocab: switched(v2.getV2ReaderVocab, legacy.getReaderVocab),
  updateWord: switched(
    (...a: Parameters<typeof v2.updateV2Word>) => v2.updateV2Word(...a).then(via('v2')),
    (...a: Parameters<typeof legacy.updateWord>) => legacy.updateWord(...a).then(via('legacy')),
  ),
  deleteWord: switched(v2.deleteV2Word, legacy.deleteWord),
  getReviewQueue: switched(v2.getV2ReviewQueue, legacy.getReviewQueue),
  submitReview: switched(v2.submitV2Review, legacy.submitReview),
  /** V2 only: a save answered `deleted` (the reader deleted the word earlier) offers this (#1270). */
  restoreWord: (id: string) => v2.restoreV2Word(id).then(via('v2')),
}
