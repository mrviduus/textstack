import { describe, expect, it } from 'vitest'
import { addOpened, emptyLibrary, parseLibrary, touch } from './library.mjs'

const book = { sha256: 'ab'.repeat(32), size: 1234, title: 'Alice', author: 'Carroll', originalName: 'alice.epub' }

describe('v2 local library', () => {
  it('parseLibrary_MalformedRows_DroppedAndValidRowsKept', () => {
    const good = addOpened(emptyLibrary(), book, 1, () => 'id1').lib.books[0]
    const lib = parseLibrary(JSON.stringify({ v: 1, books: [null, 7, { id: 'x' }, { id: 'y', title: 3 }, good] }))
    expect(lib?.books).toEqual([good])
  })

  it('addOpened_NewFile_AddsOneEntry', () => {
    const { lib, entry, existing } = addOpened(emptyLibrary(), book, 1, () => 'id1')
    expect(existing).toBe(false)
    expect(lib.books).toEqual([{ id: 'id1', ...book, importedAt: 1, openedAt: 1 }])
    expect(entry.id).toBe('id1')
  })

  it('addOpened_IdenticalBytesAgain_ReturnsExistingWithoutDuplicateOrReset', () => {
    const first = addOpened(emptyLibrary(), book, 1, () => 'id1').lib
    const { lib, entry, existing } = addOpened(first, { ...book, title: 'Other', originalName: 'copy.epub' }, 9, () => 'id2')
    expect(existing).toBe(true)
    expect(lib.books).toHaveLength(1)
    expect(entry).toMatchObject({ id: 'id1', title: 'Alice', originalName: 'alice.epub', importedAt: 1, openedAt: 9 })
  })

  it('addOpened_SameHashOtherSize_IsAnotherFile', () => {
    const first = addOpened(emptyLibrary(), book, 1, () => 'id1').lib
    expect(addOpened(first, { ...book, size: 1 }, 2, () => 'id2').lib.books).toHaveLength(2)
  })

  it('addOpened_MissingTitleAndAuthor_FileNameAndEmpty', () => {
    const { entry } = addOpened(emptyLibrary(), { ...book, title: ' ', author: undefined, originalName: 'My Book.EPUB' }, 1)
    expect(entry).toMatchObject({ title: 'My Book', author: '' })
  })

  it('parseLibrary_CorruptOrOtherVersion_Null', () => {
    expect(parseLibrary('{')).toBeNull()
    expect(parseLibrary('{"v":2,"books":[]}')).toBeNull()
    expect(parseLibrary(JSON.stringify(emptyLibrary()))).toEqual(emptyLibrary())
  })

  it('addOpened_ExistingFile_DoesNotMutateInputAndKeepsOrder', () => {
    let lib = addOpened(emptyLibrary(), book, 1, () => 'id1').lib
    lib = addOpened(lib, { ...book, sha256: 'cd'.repeat(32) }, 2, () => 'id2').lib
    const before = JSON.parse(JSON.stringify(lib))
    const { lib: next } = addOpened(lib, book, 5, () => 'id3')
    expect(lib).toEqual(before)
    expect(next.books.map((b: { id: string; openedAt: number }) => [b.id, b.openedAt])).toEqual([['id1', 5], ['id2', 2]])
  })

  it('addOpened_TwoImportsFromOneSnapshot_EachLacksTheOther', () => {
    // Pure: dedupe holds only if the host serialises read-modify-write of library.json (R2 host).
    const snap = emptyLibrary()
    expect(addOpened(snap, book, 1, () => 'idA').lib.books.map((x: { id: string }) => x.id)).toEqual(['idA'])
    expect(addOpened(snap, { ...book, sha256: 'cd'.repeat(32) }, 1, () => 'idB').lib.books.map((x: { id: string }) => x.id)).toEqual(['idB'])
  })

  it('touch_UnknownId_ChangesNothing', () => {
    const lib = addOpened(emptyLibrary(), book, 1, () => 'id1').lib
    expect(touch(lib, 'nope', 9)).toEqual(lib)
  })

  it('parseLibrary_NonObjectOrProtoKeys_NullOrNoPollution', () => {
    for (const j of ['null', '[]', '1', '{"v":1}', '{"v":1,"books":{}}']) expect(parseLibrary(j), j).toBeNull()
    expect(parseLibrary('{"__proto__":{"polluted":1},"v":1,"books":[]}')?.books).toEqual([])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('addOpened_DefaultId_UniqueV4Uuid', () => {
    // ADR-031 rule 3: the client mints the id and the server never renumbers it.
    const ids = new Set(Array.from({ length: 50 }, () => addOpened(emptyLibrary(), book).entry.id))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('parseLibrary_PreUuidId_StillListed', () => {
    const old = { ...addOpened(emptyLibrary(), book, 1).entry, id: 'lb_mabc123xyz' }
    expect(parseLibrary(JSON.stringify({ v: 1, books: [old] }))?.books).toEqual([old])
  })
})
