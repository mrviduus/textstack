import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveWordForBook } from './wordBook'

const NOT_FOUND = new Error('book_not_found')
/** A server that knows only `known` (null: knows every book); records the id each save carried. */
function server(known: string | null) {
  const sent: (string | null)[] = []
  const save = async (id: string | null) => {
    sent.push(id)
    if (id && known !== null && id !== known) throw NOT_FOUND
    return { word: 'quiver', bookId: id }
  }
  return { sent, save, isNotFound: (e: unknown) => e === NOT_FOUND }
}

describe('saveWordForBook (#1303)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('saveWordForBook_KnownId_SavedWithItNoLookup', async () => {
    const s = server('new')
    const resolve = vi.fn(async () => 'other')
    expect(await saveWordForBook('new', { ...s, resolve })).toEqual({ word: 'quiver', bookId: 'new' })
    expect(s.sent).toEqual(['new'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('saveWordForBook_StaleIdAfterAReKey_RetriedWithTheResolvedId', async () => {
    const s = server('new')
    expect(await saveWordForBook('old', { ...s, resolve: async () => 'new' })).toEqual({ word: 'quiver', bookId: 'new' })
    expect(s.sent).toEqual(['old', 'new'])
  })

  it('saveWordForBook_SameIdStillNotFound_SavedWithoutABook', async () => {
    const s = server('server-only')
    expect(await saveWordForBook('local', { ...s, resolve: async () => 'local' })).toEqual({ word: 'quiver', bookId: null })
    expect(s.sent).toEqual(['local', null])
  })

  it('saveWordForBook_ResolvedIdAlsoNotFound_SavedWithoutABook', async () => {
    const s = server('server-only')
    expect(await saveWordForBook('old', { ...s, resolve: async () => 'new' })).toEqual({ word: 'quiver', bookId: null })
    expect(s.sent).toEqual(['old', 'new', null])
  })

  it('saveWordForBook_ResolveFails_SavedWithoutABookAndLogged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = server('new')
    const boom = new Error('db closed')
    expect(await saveWordForBook('old', { ...s, resolve: async () => { throw boom } })).toEqual({ word: 'quiver', bookId: null })
    expect(s.sent).toEqual(['old', null])
    expect(warn).toHaveBeenCalledWith('[v2] open book id not resolved:', boom)
  })

  it('saveWordForBook_NoId_SavedWithoutABook', async () => {
    const s = server(null)
    const resolve = vi.fn(async () => 'new')
    await saveWordForBook(null, { ...s, resolve })
    expect(s.sent).toEqual([null])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('saveWordForBook_OtherError_RethrownNoFallback', async () => {
    const offline = new Error('offline')
    const sent: (string | null)[] = []
    const save = async (id: string | null) => { sent.push(id); throw offline }
    await expect(saveWordForBook('old', { save, resolve: async () => 'new', isNotFound: (e) => e === NOT_FOUND })).rejects.toBe(offline)
    expect(sent).toEqual(['old'])
  })
})
