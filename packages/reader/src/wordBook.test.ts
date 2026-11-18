import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveWordForBook } from './wordBook'

const NOT_FOUND = new Error('book_not_found')
/** A server that knows only `known` (null: knows no book); records the id each save carried. */
function server(known: string | null) {
  const sent: (string | null)[] = []
  const save = async (id: string | null) => {
    sent.push(id)
    if (id && id !== known) throw NOT_FOUND
    return { word: 'quiver' }
  }
  return { sent, save, isNotFound: (e: unknown) => e === NOT_FOUND }
}
const saved = (bookId: string | null) => ({ saved: { word: 'quiver' }, bookId })

describe('saveWordForBook (#1303)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('saveWordForBook_KnownId_SavedWithItNoLookup', async () => {
    const s = server('new')
    const resolve = vi.fn(async () => 'other')
    expect(await saveWordForBook('new', { ...s, resolve })).toEqual(saved('new'))
    expect(s.sent).toEqual(['new'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('saveWordForBook_StaleIdAfterAReKey_RetriedWithTheResolvedId', async () => {
    const s = server('new')
    expect(await saveWordForBook('old', { ...s, resolve: async () => 'new' })).toEqual(saved('new'))
    expect(s.sent).toEqual(['old', 'new'])
  })

  it('saveWordForBook_SameIdStillNotFound_SavedWithoutABook', async () => {
    const s = server(null)
    expect(await saveWordForBook('local', { ...s, resolve: async () => 'local' })).toEqual(saved(null))
    expect(s.sent).toEqual(['local', null])
  })

  it('saveWordForBook_ResolvedIdAlsoNotFound_SavedWithoutABook', async () => {
    const s = server(null)
    expect(await saveWordForBook('old', { ...s, resolve: async () => 'new' })).toEqual(saved(null))
    expect(s.sent).toEqual(['old', 'new', null])
  })

  it('saveWordForBook_ResolveFails_SavedWithoutABookAndLogged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = server('new')
    const boom = new Error('db closed')
    expect(await saveWordForBook('old', { ...s, resolve: async () => { throw boom } })).toEqual(saved(null))
    expect(s.sent).toEqual(['old', null])
    expect(warn).toHaveBeenCalledWith('[v2] open book id not resolved:', boom)
  })

  it('saveWordForBook_NoIdInMemory_ResolvedFromTheRowAndSavedWithIt', async () => {
    const s = server('row')
    const resolve = vi.fn(async () => 'row')
    expect(await saveWordForBook(null, { ...s, resolve })).toEqual(saved('row'))
    expect(s.sent).toEqual(['row'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('saveWordForBook_NoIdInMemoryResolvedNotFound_OneLookupThenWithoutABook', async () => {
    const s = server(null)
    const resolve = vi.fn(async () => 'row')
    expect(await saveWordForBook(null, { ...s, resolve })).toEqual(saved(null))
    expect(s.sent).toEqual(['row', null])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('saveWordForBook_NoIdAnywhere_SavedWithoutABook', async () => {
    const s = server(null)
    expect(await saveWordForBook(null, { ...s, resolve: async () => null })).toEqual(saved(null))
    expect(s.sent).toEqual([null])
  })

  it('saveWordForBook_OtherError_RethrownNoFallback', async () => {
    const offline = new Error('offline')
    const sent: (string | null)[] = []
    const save = async (id: string | null) => { sent.push(id); throw offline }
    await expect(saveWordForBook('old', { save, resolve: async () => 'new', isNotFound: (e) => e === NOT_FOUND })).rejects.toBe(offline)
    expect(sent).toEqual(['old'])
  })
})
