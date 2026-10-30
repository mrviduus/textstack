import { describe, expect, it } from 'vitest'
import { addOpened, emptyLibrary, parseLibrary } from './library.mjs'

const book = { sha256: 'ab'.repeat(32), size: 1234, title: 'Alice', author: 'Carroll', originalName: 'alice.epub' }

describe('v2 local library', () => {
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
})
