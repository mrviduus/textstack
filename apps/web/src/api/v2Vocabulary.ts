/**
 * Vocabulary on V2 (#1025 M2.7): `@textstack/shared`'s V2 vocabulary (one copy for web and mobile)
 * with the browser's ids and the last library pull's files. Stats, settings, clusters, lookups and
 * pending words stay legacy whatever the flag (V2 holds no such data, ADR-031 D6).
 */
import { createV2Vocabulary } from '@textstack/shared'
import { v2Book } from './v2'

export const {
  saveV2Word, getV2Words, getV2ReaderVocab, deleteV2Word, updateV2Word, getV2ReviewQueue, submitV2Review,
} = createV2Vocabulary({
  newId: () => crypto.randomUUID(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
})
