// Tests only: expo-sqlite's async surface (localLibrary's `Db`) over one in-memory node:sqlite connection.
import { DatabaseSync } from 'node:sqlite'
import type { Db } from './localLibrary'
import type { Connection } from './sqliteDb'

const bind = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p)) as never[]

export function memoryDb(): Db & { raw: DatabaseSync } {
  const d = new DatabaseSync(':memory:')
  const tick = () => new Promise((r) => setTimeout(r, 0))
  return {
    raw: d,
    execAsync: async (sql) => { await tick(); d.exec(sql) },
    runAsync: async (sql, params) => { await tick(); return d.prepare(sql).run(...bind(params)) },
    getFirstAsync: async <T>(sql: string, params?: unknown[]) => { await tick(); return (d.prepare(sql).get(...bind(params)) ?? null) as T | null },
    getAllAsync: async <T>(sql: string, params?: unknown[]) => { await tick(); return d.prepare(sql).all(...bind(params)) as T[] },
    // expo-sqlite's own shape: BEGIN inside the try, ROLLBACK on any error.
    withTransactionAsync: async (fn) => {
      try { d.exec('BEGIN'); await fn(); d.exec('COMMIT') } catch (e) { d.exec('ROLLBACK'); throw e }
    },
  }
}

/**
 * The plugin's connection over node:sqlite, with its rules: each call opens its own transaction unless told
 * `transaction: false`, and a transaction inside an open one fails (as SQLite does). `execute` splits as the
 * Android plugin does (`UtilsSQLite.getStatementsArray`): on ";\n", `--` cut per line, one statement run per part.
 */
export function memoryConnection(): Connection & { raw: DatabaseSync } {
  const d = new DatabaseSync(':memory:')
  const own = <T>(transaction: boolean | undefined, fn: () => T): T => {
    if (transaction === false) return fn()
    d.exec('BEGIN')
    try { const out = fn(); d.exec('COMMIT'); return out } catch (e) { d.exec('ROLLBACK'); throw e }
  }
  const changes = { changes: { changes: 0 } }
  const c = {
    raw: d,
    execute: async (sql: string, transaction?: boolean) => own(transaction, () => {
      for (const part of sql.split(';\n')) {
        const one = part.split('\n').map((l) => l.trim().split('--')[0]).filter(Boolean).join(' ')
        if (one) d.prepare(one).run()
      }
      return changes
    }),
    run: async (sql: string, values: never[] = [], transaction?: boolean) => own(transaction, () => { d.prepare(sql).run(...values); return changes }),
    query: async (sql: string, values: never[] = []) => ({ values: d.prepare(sql).all(...values) }),
    beginTransaction: async () => { d.exec('BEGIN'); return changes },
    commitTransaction: async () => { d.exec('COMMIT'); return changes },
    rollbackTransaction: async () => { d.exec('ROLLBACK'); return changes },
  }
  return c
}
