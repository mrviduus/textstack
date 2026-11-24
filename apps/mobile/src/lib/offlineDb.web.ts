// Web twin of offlineDb.ts: the native module pulls in expo-sqlite, whose web shim imports `.wasm`
// that Metro's web bundler cannot resolve. Every export is mirrored; web never had the cache.

export async function dropChapterCache(): Promise<void> {}
export async function dropOriginalsCache(): Promise<void> {}
