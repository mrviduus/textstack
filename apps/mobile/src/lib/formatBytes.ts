/**
 * Bytes, the way this app writes them.
 *
 * There were three copies of this — `StorageQuotaRow.tsx`, `my-books/upload.tsx`
 * and a fourth about to be added for the download button — and they had already
 * started to differ in how many decimals they kept. A size shown two screens
 * apart should not be spelled two ways, so there is one now.
 *
 * The number style is the one readers already see on the quota row: a single
 * decimal for KB and MB, two for GB. Whole bytes below a kilobyte, because a
 * fraction of a byte is nonsense.
 */
export function formatBytes(bytes: number): string
export function formatBytes(bytes: number | null | undefined): string | null
export function formatBytes(bytes: number | null | undefined): string | null {
  // Null is a real answer — "the server did not tell us" — and callers render
  // nothing rather than a zero that would read as an empty file.
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
