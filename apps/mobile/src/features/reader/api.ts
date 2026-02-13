import type { AxiosError } from 'axios';
import { createMutation, createQuery } from 'react-query-kit';

import { client } from '@/lib/api';
import type { Chapter, ReadingProgressDto, UpsertProgressRequest } from '@/lib/api/types';

const DEFAULT_LANG = 'en';

export const useChapter = createQuery<
  Chapter,
  { bookSlug: string; chapterSlug: string; language?: string },
  AxiosError
>({
  queryKey: ['chapter'],
  fetcher: (variables) => {
    const lang = variables.language ?? DEFAULT_LANG;
    return client
      .get(`/${lang}/books/${variables.bookSlug}/chapters/${variables.chapterSlug}`)
      .then((r) => r.data);
  },
});

export const useReadingProgress = createQuery<
  ReadingProgressDto | null,
  { editionId: string },
  AxiosError
>({
  queryKey: ['reading-progress'],
  fetcher: (variables) =>
    client
      .get(`/me/progress/${variables.editionId}`)
      .then((r) => r.data)
      .catch((e) => {
        if (e.response?.status === 404) return null;
        throw e;
      }),
});

export const useUpsertProgress = createMutation<
  ReadingProgressDto,
  { editionId: string; data: UpsertProgressRequest },
  AxiosError
>({
  mutationFn: ({ editionId, data }) =>
    client.put(`/me/progress/${editionId}`, data).then((r) => r.data),
});
