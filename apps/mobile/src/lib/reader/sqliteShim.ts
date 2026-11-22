// Tests only: expo-sqlite's async surface (localLibrary's `Db`) over one in-memory node:sqlite connection.
import { DatabaseSync } from 'node:sqlite'
import type { Db } from './localLibrary'

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
