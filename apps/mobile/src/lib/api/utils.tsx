export const DEFAULT_LIMIT = 20;

export function getQueryKey<T extends Record<string, unknown>>(key: string, params?: T) {
  return [key, ...(params ? [params] : [])];
}
