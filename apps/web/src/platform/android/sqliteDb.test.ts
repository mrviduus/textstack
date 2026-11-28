// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLocalLibrary } from './localLibrary'
import { toDb } from './sqliteDb'
import { memoryConnection as pluginConnection } from './sqliteShim'


const book = { sha256: 'ab'.repeat(32), size: 10, title: 'T', author: '', originalName: 'b.epub', format: 'epub' }

describe('the local library over the Capacitor SQLite connection', () => {
  it('addOpened_ThenBooks_TheBookIsListedWithItsOutboxEntry', async () => {
    const lib = createLocalLibrary(toDb(pluginConnection()))
    const ids = [randomUUID(), randomUUID()]
    await lib.addOpened(book, () => ids.shift()!)
    const books = await lib.books()
    expect(books.map((b) => b.sha256)).toEqual([book.sha256])
    expect(await lib.outbox()).toEqual([{ kind: 'book', target: books[0].id, gen: 1, failures: 0 }])
  })

  it('withTransactionAsync_FnThrows_RolledBackAndRethrown', async () => {
    const db = toDb(pluginConnection())
    await db.execAsync('CREATE TABLE t (v TEXT)')
    await expect(db.withTransactionAsync(async () => {
      await db.runAsync('INSERT INTO t (v) VALUES (?)', ['x'])
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await db.getAllAsync('SELECT * FROM t')).toEqual([])
  })

  it('migrate_FirstOpen_EveryTableOfTheSchemaExists', async () => {
    const c = pluginConnection()
    await createLocalLibrary(toDb(c)).books()
    const tables = (await c.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).values!.map((r) => r.name)
    expect(tables).toEqual(['annotations', 'books', 'meta', 'outbox', 'reading_sessions', 'reading_state', 'vocabulary'])
  })

  it('getFirstAsync_NoRow_Null', async () => {
    const db = toDb(pluginConnection())
    await db.execAsync('CREATE TABLE t (v TEXT)')
    expect(await db.getFirstAsync('SELECT * FROM t')).toBeNull()
  })

  it('runAsync_UndefinedParam_BoundAsNull', async () => {
    const db = toDb(pluginConnection())
    await db.execAsync('CREATE TABLE t (v TEXT)')
    await db.runAsync('INSERT INTO t (v) VALUES (?)', [undefined])
    expect(await db.getAllAsync('SELECT * FROM t')).toEqual([{ v: null }])
  })
})
