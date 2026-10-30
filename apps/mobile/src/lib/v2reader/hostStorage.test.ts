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

const SHA_A = 'AB'.repeat(32)
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
    const { files, data } = memoryFiles()
    files.write = async (name) => { data.set(name, ''); throw new Error('ENOSPC') }
    await expect(writeAtomically(files, 'library.json', '{}')).rejects.toThrow('ENOSPC')
    expect([...data.keys()]).toEqual([])
  })

  it('writeAtomically_WriteAndTmpRemovalBothFail_TheWriteErrorPropagates', async () => {
    const { files, data } = memoryFiles()
    files.write = async (name) => { data.set(name, ''); throw new Error('ENOSPC') }
    files.remove = () => { throw new Error('remove failed') }
    await expect(writeAtomically(files, 'library.json', '{}')).rejects.toThrow('ENOSPC')
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
    expect((await storage.books()).map((b) => b.sha256)).toEqual([SHA_A.toLowerCase(), SHA_B])
  })

  it('addOpened_SameBytesInUpperCase_ExistingEntryAndStagedCopyDropped', async () => {
    const { files, data } = memoryFiles()
    const storage = createV2Storage(files)
    data.set('staging/1.epub', 'bytes')
    await storage.addOpened(book(SHA_A.toLowerCase()), 'staging/1.epub')
    data.set('staging/2.epub', 'bytes')
    const { books } = await storage.addOpened(book(SHA_A), 'staging/2.epub')
    expect(books).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A.toLowerCase()}.epub`])
  })

  it('addOpened_BytesAlreadyRetained_AdoptsTheFileAndDropsTheStagedCopy', async () => {
    const { files, data, ops } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set(`books/${sha}.epub`, 'retained')
    data.set('staging/1.epub', 'staged')
    const { books } = await createV2Storage(files).addOpened(book(sha), 'staging/1.epub')
    expect(books.map((b) => b.sha256)).toEqual([sha])
    expect(data.get(`books/${sha}.epub`)).toBe('retained')
    expect(data.has('staging/1.epub')).toBe(false)
    expect(ops.some((o) => o.startsWith('move staging/'))).toBe(false)
  })

  it('addOpened_LibraryWriteFailsAfterTheMove_RemovesTheRetainedCopyAndRethrows', async () => {
    const { files, data } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set('library.json', 'old')
    data.set('staging/1.epub', 'staged')
    const write = files.write
    files.write = async (name, text) => {
      if (name === 'library.json.tmp') throw new Error('ENOSPC')
      return write(name, text)
    }
    await expect(createV2Storage(files).addOpened(book(sha), 'staging/1.epub')).rejects.toThrow('ENOSPC')
    expect([...data]).toEqual([['library.json', 'old']])
  })

  it('addOpened_LibraryWriteFailsForAnAdoptedCopy_KeepsTheCopy', async () => {
    const { files, data } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set(`books/${sha}.epub`, 'retained')
    data.set('staging/1.epub', 'staged')
    files.write = async () => { throw new Error('ENOSPC') }
    await expect(createV2Storage(files).addOpened(book(sha), 'staging/1.epub')).rejects.toThrow('ENOSPC')
    expect([...data]).toEqual([[`books/${sha}.epub`, 'retained']])
  })

  it('addOpened_SameBytesConcurrently_OneEntryOneFile', async () => {
    const { files, data } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set('staging/1.epub', 'x')
    data.set('staging/2.epub', 'x')
    const storage = createV2Storage(files)
    await Promise.all([storage.addOpened(book(sha), 'staging/1.epub'), storage.addOpened(book(SHA_A), 'staging/2.epub')])
    expect(await storage.books()).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${sha}.epub`])
  })

  it('writeStore_FailedWrite_RejectsToItsCallerAndTheNextWriteRuns', async () => {
    const { files, data } = memoryFiles()
    const move = files.move
    let failOnce = true
    files.move = async (from, to) => {
      if (failOnce) { failOnce = false; throw new Error('disk') }
      return move(from, to)
    }
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
    expect(data.get(`store/${SHA_A.toLowerCase()}.json`)).toBe('{"v":1, "kept":"as sent"}')
    expect(await storage.readStore(SHA_A.toLowerCase())).toBe('{"v":1, "kept":"as sent"}')
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
