import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createV2Storage, nonceFromUuid, readRecovering, sha256Key, writeAtomically, type V2Files } from './hostStorage'
import { v2ReaderPageHtml } from './v2ReaderPage.generated'

/** In-memory files that log every operation and yield between steps, as the native calls do. */
function memoryFiles() {
  const data = new Map<string, string>()
  const ops: string[] = []
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const files: V2Files = {
    async read(name) { await tick(); return data.get(name) ?? null },
    async write(name, text) { ops.push(`write ${name}`); await tick(); data.set(name, text) },
    async move(from, to) {
      ops.push(`move ${from} ${to}`)
      await tick()
      const text = data.get(from)
      if (text === undefined) throw new Error(`no ${from}`)
      data.set(to, text)
      data.delete(from)
    },
    exists: (name) => data.has(name),
    remove: (name) => { ops.push(`remove ${name}`); data.delete(name) },
  }
  return { files, data, ops }
}

/** `op` on `name` (from-name for a move; any name if omitted) rejects with `error`, once or always. A
 *  failing write first leaves the empty file ENOSPC does. */
function failOn(m: ReturnType<typeof memoryFiles>, op: 'write' | 'move', error: string, { name, once = false }: { name?: string; once?: boolean } = {}) {
  const real = m.files[op]
  let armed = true
  m.files[op] = async (a: string, b: string) => {
    if (!armed || (name !== undefined && a !== name)) return real(a, b)
    if (once) armed = false
    if (op === 'write') m.data.set(a, '')
    throw new Error(error)
  }
}

const SHA_A = 'AB'.repeat(32)
const SHA_A_KEY = SHA_A.toLowerCase()
const SHA_B = 'cd'.repeat(32)
const book = (sha256: string) => ({ sha256, size: 10, title: 'T', author: '', originalName: 'b.epub' })

describe('v2 host storage', () => {
  it('writeAtomically_AnyWrite_WritesTmpThenMovesItOverTheTarget', async () => {
    const { files, data, ops } = memoryFiles()
    await writeAtomically(files, 'library.json', '{}')
    expect(ops).toEqual(['write library.json.tmp', 'move library.json.tmp library.json'])
    expect([...data]).toEqual([['library.json', '{}']])
  })

  it('writeAtomically_WriteFails_RemovesTheTmpAndRethrows', async () => {
    const m = memoryFiles()
    failOn(m, 'write', 'ENOSPC')
    await expect(writeAtomically(m.files, 'library.json', '{}')).rejects.toThrow('ENOSPC')
    expect([...m.data.keys()]).toEqual([])
  })

  it('writeAtomically_WriteAndTmpRemovalBothFail_TheWriteErrorPropagates', async () => {
    const m = memoryFiles()
    failOn(m, 'write', 'ENOSPC')
    m.files.remove = () => { throw new Error('remove failed') }
    await expect(writeAtomically(m.files, 'library.json', '{}')).rejects.toThrow('ENOSPC')
  })

  it('writeAtomically_MoveFails_KeepsTheCompleteTmpAndTheTarget', async () => {
    const m = memoryFiles()
    const { files, data } = m
    data.set('x.json', 'old')
    failOn(m, 'move', 'EIO')
    await expect(writeAtomically(files, 'x.json', 'new')).rejects.toThrow('EIO')
    expect(data.get('x.json.tmp')).toBe('new')
    expect(data.get('x.json')).toBe('old')
  })

  it('readRecovering_TargetMissing_ReadsTheTmp_TargetPresent_TargetWins', async () => {
    const { files, data } = memoryFiles()
    data.set('store/x.json.tmp', 'new')
    expect(await readRecovering(files, 'store/x.json')).toBe('new')
    data.set('store/x.json', 'old')
    // Even a complete tmp loses to an existing target: a save killed before its move is lost.
    expect(await readRecovering(files, 'store/x.json')).toBe('old')
  })

  it('addOpened_TwoConcurrentImports_BothLand', async () => {
    const { files } = memoryFiles()
    const storage = createV2Storage(files)
    await Promise.all([storage.addOpened(book(SHA_A), null), storage.addOpened(book(SHA_B), null)])
    expect((await storage.books()).map((b) => b.sha256)).toEqual([SHA_A_KEY, SHA_B])
  })

  it('addOpened_SameBytesInUpperCase_ExistingEntryAndStagedCopyDropped', async () => {
    const { files, data } = memoryFiles()
    const storage = createV2Storage(files)
    data.set('staging/1.epub', 'bytes')
    await storage.addOpened(book(SHA_A_KEY), 'staging/1.epub')
    data.set('staging/2.epub', 'bytes')
    const { books } = await storage.addOpened(book(SHA_A), 'staging/2.epub')
    expect(books).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A_KEY}.epub`])
  })

  it('addOpened_BytesAlreadyRetained_AdoptsTheFileAndDropsTheStagedCopy', async () => {
    const { files, data, ops } = memoryFiles()
    data.set(`books/${SHA_A_KEY}.epub`, 'retained')
    data.set('staging/1.epub', 'staged')
    const { books } = await createV2Storage(files).addOpened(book(SHA_A_KEY), 'staging/1.epub')
    expect(books.map((b) => b.sha256)).toEqual([SHA_A_KEY])
    expect(data.get(`books/${SHA_A_KEY}.epub`)).toBe('retained')
    expect(data.has('staging/1.epub')).toBe(false)
    expect(ops.some((o) => o.startsWith('move staging/'))).toBe(false)
  })

  it('addOpened_LibraryWriteFailsAfterTheMove_RemovesTheRetainedCopyAndRethrows', async () => {
    const m = memoryFiles()
    const { files, data } = m
    data.set('library.json', 'old')
    data.set('staging/1.epub', 'staged')
    failOn(m, 'write', 'ENOSPC', { name: 'library.json.tmp' })
    await expect(createV2Storage(files).addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('ENOSPC')
    expect([...data]).toEqual([['library.json', 'old']])
  })

  it('addOpened_LibraryWriteFailsForAnAdoptedCopy_KeepsTheCopy', async () => {
    const m = memoryFiles()
    const { files, data } = m
    data.set(`books/${SHA_A_KEY}.epub`, 'retained')
    data.set('staging/1.epub', 'staged')
    failOn(m, 'write', 'ENOSPC')
    await expect(createV2Storage(files).addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('ENOSPC')
    expect([...data]).toEqual([[`books/${SHA_A_KEY}.epub`, 'retained']])
  })

  it('addOpened_FirstImportLibraryMoveFails_KeepsTheCopyTheRecoveredEntryNames', async () => {
    const m = memoryFiles()
    const { files, data } = m
    data.set('staging/1.epub', 's')
    failOn(m, 'move', 'EIO', { name: 'library.json.tmp' })
    const storage = createV2Storage(files)
    await expect(storage.addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('EIO')
    // No library.json: readRecovering reads the complete tmp, which lists the book, so its file stays.
    expect((await storage.books()).map((b) => b.sha256)).toEqual([SHA_A_KEY])
    expect(data.has(`books/${SHA_A_KEY}.epub`)).toBe(true)
  })

  it('addOpened_LibraryMoveDeletesTheTargetThenFails_KeepsTheCopyTheRecoveredEntryNames', async () => {
    const { files, data } = memoryFiles()
    data.set('library.json', JSON.stringify({ v: 1, books: [] }))
    data.set('staging/1.epub', 's')
    const move = files.move
    // expo-file-system's overwriting move: the target is deleted before the rename, which then fails.
    files.move = async (from, to) => {
      if (from === 'library.json.tmp') { data.delete(to); throw new Error('rename failed') }
      return move(from, to)
    }
    const storage = createV2Storage(files)
    await expect(storage.addOpened(book(SHA_A_KEY), 'staging/1.epub')).rejects.toThrow('rename failed')
    expect((await storage.books()).map((b) => b.sha256)).toEqual([SHA_A_KEY])
    expect(data.has(`books/${SHA_A_KEY}.epub`)).toBe(true)
  })

  it('addOpened_FirstFailsSecondAdoptsSameBytes_OneCopyOneEntry', async () => {
    const m = memoryFiles()
    const { files, data } = m
    data.set('staging/1.epub', 'x')
    data.set('staging/2.epub', 'x')
    failOn(m, 'write', 'ENOSPC', { name: 'library.json.tmp', once: true })
    const storage = createV2Storage(files)
    const [first, second] = await Promise.allSettled([storage.addOpened(book(SHA_A_KEY), 'staging/1.epub'), storage.addOpened(book(SHA_A_KEY), 'staging/2.epub')])
    expect([first.status, second.status]).toEqual(['rejected', 'fulfilled'])
    expect(await storage.books()).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A_KEY}.epub`])
  })

  it('addOpened_SameBytesConcurrently_OneEntryOneFile', async () => {
    const { files, data } = memoryFiles()
    data.set('staging/1.epub', 'x')
    data.set('staging/2.epub', 'x')
    const storage = createV2Storage(files)
    await Promise.all([storage.addOpened(book(SHA_A_KEY), 'staging/1.epub'), storage.addOpened(book(SHA_A), 'staging/2.epub')])
    expect(await storage.books()).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A_KEY}.epub`])
  })

  it('writeStore_FailedWrite_RejectsToItsCallerAndTheNextWriteRuns', async () => {
    const m = memoryFiles()
    const { files, data } = m
    failOn(m, 'move', 'disk', { once: true })
    const storage = createV2Storage(files)
    const first = storage.writeStore(SHA_B, 'one')
    const second = storage.writeStore(SHA_B, 'two')
    await expect(first).rejects.toThrow('disk')
    await second
    expect(data.get(`store/${SHA_B}.json`)).toBe('two')
  })

  it('writeStore_HostileKey_RejectsAndWritesNothing', async () => {
    const { files, ops } = memoryFiles()
    const storage = createV2Storage(files)
    await expect(storage.writeStore('../../x', '{}')).rejects.toThrow('not a sha256')
    await expect(storage.addOpened(book('../x'), null)).rejects.toThrow('not a sha256')
    expect(ops).toEqual([])
  })

  it('readStore_QueuedBehindAWrite_ReadsTheNewValue', async () => {
    const { files, data } = memoryFiles()
    data.set(`store/${SHA_B}.json`, 'old')
    const storage = createV2Storage(files)
    const write = storage.writeStore(SHA_B, 'new')
    expect(await storage.readStore(SHA_B)).toBe('new')
    await write
  })

  it('writeStore_UpperCaseKey_ReadBackUnderLowerCaseVerbatim', async () => {
    const { files, data } = memoryFiles()
    const storage = createV2Storage(files)
    await storage.writeStore(SHA_A, '{"v":1, "kept":"as sent"}')
    expect(data.get(`store/${SHA_A_KEY}.json`)).toBe('{"v":1, "kept":"as sent"}')
    expect(await storage.readStore(SHA_A_KEY)).toBe('{"v":1, "kept":"as sent"}')
  })

  it('sha256Key_NotSixtyFourHex_Throws', () => {
    for (const bad of ['', 'ab'.repeat(31), `${'ab'.repeat(32)}/`, '../'.repeat(22)]) expect(() => sha256Key(bad), bad).toThrow()
  })

  it('nonceFromUuid_RandomUuid_ThirtyTwoHexThePageAccepts', () => {
    const nonce = nonceFromUuid(randomUUID())
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(v2ReaderPageHtml(nonce)).toContain(`'nonce-${nonce}'`)
    expect(() => nonceFromUuid('not-a-uuid')).toThrow()
  })
})
