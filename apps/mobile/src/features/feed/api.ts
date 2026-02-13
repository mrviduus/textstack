import type { AxiosError } from 'axios';
import { createQuery } from 'react-query-kit';
import { client } from '@/lib/api';
import type { BookDetail, Edition, PaginatedResponse, SearchResult, Suggestion } from '@/lib/api/types';

// Use English as default; will be configurable via language store later
const DEFAULT_LANG = 'en';

export const useBooks = createQuery<PaginatedResponse<Edition>, { language?: string; limit?: number; offset?: number } | void, AxiosError>({
  queryKey: ['books'],
  fetcher: (variables) => {
    const lang = variables?.language ?? DEFAULT_LANG;
    const params: Record<string, string> = {};
    if (variables?.limit) params.limit = String(variables.limit);
    if (variables?.offset) params.offset = String(variables.offset);
    return client.get(`/${lang}/books`, { params }).then(r => r.data);
  },
});

export const useBook = createQuery<BookDetail, { slug: string; language?: string }, AxiosError>({
  queryKey: ['book'],
  fetcher: (variables) => {
    const lang = variables.language ?? DEFAULT_LANG;
    return client.get(`/${lang}/books/${variables.slug}`).then(r => r.data);
  },
});

export const useSearch = createQuery<PaginatedResponse<SearchResult>, { q: string; language?: string; limit?: number; offset?: number }, AxiosError>({
  queryKey: ['search'],
  fetcher: (variables) => {
    const lang = variables.language ?? DEFAULT_LANG;
    const params: Record<string, string> = { q: variables.q };
    if (variables.limit) params.limit = String(variables.limit);
    if (variables.offset) params.offset = String(variables.offset);
    return client.get(`/${lang}/search`, { params }).then(r => r.data);
  },
});

export const useSuggestions = createQuery<Suggestion[], { q: string; language?: string; limit?: number }, AxiosError>({
  queryKey: ['suggestions'],
  fetcher: (variables) => {
    const lang = variables.language ?? DEFAULT_LANG;
    const params: Record<string, string> = { q: variables.q };
    if (variables.limit) params.limit = String(variables.limit);
    return client.get(`/${lang}/search/suggest`, { params }).then(r => r.data);
  },
});
