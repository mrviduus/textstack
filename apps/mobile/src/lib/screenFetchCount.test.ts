import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Source-asserting guard (style of `chapterLoadOrder.test.ts`): how many call
 * sites each screen has for the requests it makes on open. Screens can't run
 * under Vitest, and a duplicate fetch is invisible in use — the screen looks
 * the same, it just costs twice. Each of these was a real double request.
 */
const root = resolve(__dirname, '../..')
const read = (f: string) => readFileSync(resolve(root, f), 'utf8')
const count = (src: string, needle: string) => src.split(needle).length - 1

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [p] : []
  })
}

describe('one open = one fetch per resource', () => {
  it('Library: focus owns the load — no mount effect, no `loading` dep re-firing it', () => {
    const src = read('app/(tabs)/library.tsx')
    expect(count(src, 'userBooksApi.getUserBooks(')).toBe(2) // load + the processing poll
    expect(src).not.toMatch(/useEffect\(\(\) => \{ loadData\(\) \}/)
    expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ loadData\(\) \}, \[loadData\]\)\)/)
  })

  it('my-books detail: progress on mount, focus refresh skips the first focus', () => {
    const src = read('app/my-books/[id].tsx')
    expect(count(src, 'userBooksApi.getUserBookProgress(')).toBe(2) // load + re-focus
    expect(src).toContain('useRefocusEffect(')
    expect(src).not.toContain('useFocusEffect(')
  })

  it('Vocabulary: mount effect loads; focus refresh is re-focus only', () => {
    const src = read('app/(tabs)/vocabulary.tsx')
    expect(src).toContain('useRefocusEffect(')
    expect(src).not.toContain('[loading, loadData]')
  })

  it('useRefocusEffect skips the first focus and never re-fires on identity change', () => {
    const src = read('src/hooks/useRefocusEffect.ts')
    expect(src).toContain('if (!focusedOnceRef.current) { focusedOnceRef.current = true; return }')
    expect(src).toMatch(/useFocusEffect\(useCallback\([\s\S]*?\}, \[\]\)\)/)
  })

  it('my-books detail: one GET of the book per load, no polling (#1522: no processing state)', () => {
    const src = read('app/my-books/[id].tsx')
    expect(count(src, 'userBooksApi.getUserBook(')).toBe(1)
    expect(src).not.toContain('setInterval(')
  })

  it('insights: fetched only by useBookReviews, never by the section it feeds', () => {
    const callers = [...walk(resolve(root, 'app')), ...walk(resolve(root, 'src'))]
      .filter(f => read(f).includes('insightsApi.getBookInsights('))
      .map(f => f.slice(root.length + 1))
    expect(callers).toEqual(['src/hooks/useBookReviews.ts'])
  })
})
