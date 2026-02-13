import type { AxiosError } from 'axios';
import { createMutation, createQuery } from 'react-query-kit';
import { client } from '@/lib/api';
import type { LibraryItem, PaginatedResponse } from '@/lib/api/types';

export const useLibrary = createQuery<
  PaginatedResponse<LibraryItem>,
  void,
  AxiosError
>({
  queryKey: ['library'],
  fetcher: () => client.get('/me/library').then((r) => r.data),
});

export const useAddToLibrary = createMutation<
  LibraryItem,
  { editionId: string },
  AxiosError
>({
  mutationFn: ({ editionId }) =>
    client.post(`/me/library/${editionId}`).then((r) => r.data),
});

export const useRemoveFromLibrary = createMutation<
  void,
  { editionId: string },
  AxiosError
>({
  mutationFn: ({ editionId }) =>
    client.delete(`/me/library/${editionId}`).then((r) => r.data),
});
