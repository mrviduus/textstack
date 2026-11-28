// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createLocalLibrary } from './localLibrary'
import { toDb, type Connection } from './sqliteDb'

/**
 * The plugin's connection over node:sqlite, with its rules: each call opens its own transaction unless told
 * `transaction: false`, and a transaction inside an open one fails (as SQLite does).
 */
function pluginConnection() {
  const d = new DatabaseSync(':memory:')
  const own = <T>(transaction: boolean | undefined, fn: () => T): T => {
    if (transaction === false) return fn()
    d.exec('BEGIN')
    try { const out = fn(); d.exec('COMMIT'); return out } catch (e) { d.exec('ROLLBACK'); throw e }
  }
  const changes = { changes: { changes: 0 } }
  const c: Connection = {
    execute: async (sql, transaction) => own(transaction, () => { d.exec(sql); return changes }),
    run: async (sql, values = [], transaction) => own(transaction, () => { d.prepare(sql).run(...values); return changes }),
    query: async (sql, values = []) => ({ values: d.prepare(sql).all(...values) }),
    beginTransaction: async () => { d.exec('BEGIN'); return changes },
    commitTransaction: async () => { d.exec('COMMIT'); return changes },
    rollbackTransaction: async () => { d.exec('ROLLBACK'); return changes },
  }
  return c
}

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

  it('getFirstAsync_NoRow_Null_UndefinedParamBoundAsNull', async () => {
    const db = toDb(pluginConnection())
    await db.execAsync('CREATE TABLE t (v TEXT)')
    await db.runAsync('INSERT INTO t (v) VALUES (?)', [undefined])
    expect(await db.getFirstAsync('SELECT * FROM t WHERE v IS NOT NULL')).toBeNull()
    expect(await db.getAllAsync('SELECT * FROM t')).toEqual([{ v: null }])
  })
})
