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
      data.delete(to)
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

  it('readRecovering_KilledBetweenDeleteAndRename_ReadsTheCompleteTmp', async () => {
    const { files, data } = memoryFiles()
    data.set('store/x.json.tmp', 'new')
    expect(await readRecovering(files, 'store/x.json')).toBe('new')
    data.set('store/x.json', 'old')
    // A tmp beside its target never finished being written: the target wins.
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
    const { existing } = await storage.addOpened(book(SHA_A), 'staging/2.epub')
    expect(existing).toBe(true)
    expect(await storage.books()).toHaveLength(1)
    expect([...data.keys()].filter((k) => k.endsWith('.epub'))).toEqual([`books/${SHA_A.toLowerCase()}.epub`])
  })

  it('addOpened_BytesAlreadyRetained_AdoptsTheFileAndDropsTheStagedCopy', async () => {
    const { files, data, ops } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set(`books/${sha}.epub`, 'retained')
    data.set('staging/1.epub', 'staged')
    const { existing } = await createV2Storage(files).addOpened(book(sha), 'staging/1.epub')
    expect(existing).toBe(false)
    expect(data.get(`books/${sha}.epub`)).toBe('retained')
    expect(data.has('staging/1.epub')).toBe(false)
    expect(ops.some((o) => o.startsWith('move staging/'))).toBe(false)
  })

  it('addOpened_SameBytesConcurrently_OneEntryOneFile', async () => {
    const { files, data } = memoryFiles()
    const sha = SHA_A.toLowerCase()
    data.set('staging/1.epub', 'x')
    data.set('staging/2.epub', 'x')
    const storage = createV2Storage(files)
    const results = await Promise.all([storage.addOpened(book(sha), 'staging/1.epub'), storage.addOpened(book(SHA_A), 'staging/2.epub')])
    expect(results.map((r) => r.existing)).toEqual([false, true])
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
    let pending: Promise<void> | undefined
    expect(() => { pending = storage.writeStore('../../x', '{}') }).not.toThrow()
    await expect(pending).rejects.toThrow('not a sha256')
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
