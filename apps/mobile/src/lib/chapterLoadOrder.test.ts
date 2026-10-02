import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-asserting guard, in the style of `authBootstrapOrder.test.ts`.
 *
 * Both chapter loaders read the device **before** the network, and that ordering
 * is the entire fix: reversed, the code still behaves perfectly on a good
 * connection and on a plane (where `fetch` rejects in milliseconds), and fails
 * only on a network that is present but useless — a captive portal, a tunnel,
 * hotel Wi-Fi that opens the socket and never answers. A reader there waits out
 * the whole socket timeout in front of a book that is already on the phone.
 *
 * That is a failure no test environment reproduces and no reviewer sees, which
 * is exactly why it is worth pinning in the source. It cost nothing to write
 * network-first the first time round; it would cost nothing to write it again.
 */
const LOADERS = [
  {
    file: 'src/hooks/useReaderChapter.ts',
    cache: 'getCachedChapter(',
    network: 'api.getChapter(',
    refresh: 'refreshCachedChapter(',
  },
  {
    file: 'src/components/reader/useUserBookReaderSource.ts',
    cache: 'getCachedUserChapter(',
    network: 'userBooksApi.getUserBookChapter(',
    refresh: 'refreshCachedUserChapter(',
  },
]

/**
 * Infinite scroll is the same question one chapter later, and its failure branch
 * is `disableInfiniteScroll()` — so getting the order wrong there does not show
 * an error, it silently stops the book from scrolling. The catalogue path had no
 * cache read at all until 2026-09-28.
 */
const APPENDERS = [
  {
    file: 'src/components/reader/useEditionReaderSource.ts',
    cache: 'getCachedChapter(editionId, slug)',
    network: 'getChapter(bookSlug, slug)',
  },
  {
    file: 'src/components/reader/useUserBookReaderSource.ts',
    cache: 'getCachedUserChapter(bookId, slug)',
    network: 'getUserBookChapter(bookId, slug)',
  },
]

describe.each(APPENDERS)('$file — appending the next chapter', ({ file, cache, network }) => {
  const source = readFileSync(resolve(__dirname, '../..', file), 'utf8')

  it('reads the cache before it reaches for the network', () => {
    const cacheAt = source.indexOf(cache)
    const networkAt = source.indexOf(network)
    expect(cacheAt).toBeGreaterThan(-1)
    expect(networkAt).toBeGreaterThan(cacheAt)
  })
})

describe.each(LOADERS)('$file', ({ file, cache, network, refresh }) => {
  const source = readFileSync(resolve(__dirname, '../..', file), 'utf8')

  it('reads the cache before it reaches for the network', () => {
    const cacheAt = source.indexOf(cache)
    const networkAt = source.indexOf(network)
    expect(cacheAt).toBeGreaterThan(-1)
    expect(networkAt).toBeGreaterThan(cacheAt)
  })

  it('refreshes the stored copy in place rather than re-rendering the chapter', () => {
    // `refreshCachedChapter`/`refreshCachedUserChapter` are UPDATEs that leave
    // `cached_at` alone. Swapping to the insert-or-replace pair would send every
    // chapter the reader visits to the bottom of the offline table of contents,
    // which is ordered by that column.
    expect(source).toContain(refresh)
    expect(source).not.toMatch(/void cacheChapter\(|void cacheUserChapter\(/)
  })
})
