// The local library's `Db` (localLibrary.ts) over @capacitor-community/sqlite. The database name is the Expo app's
// (`textstack-v2`), but the file is not: the plugin keeps `databases/textstack-v2SQLite.db`, expo-sqlite kept
// `files/SQLite/textstack-v2`. Moving an existing install's file is #1643's job.
import type { SQLiteDBConnection } from '@capacitor-community/sqlite'
import type { Db } from './localLibrary'

export const DB_NAME = 'textstack-v2'

/** The connection methods `toDb` calls; tests give a fake one. */
export type Connection = Pick<SQLiteDBConnection, 'execute' | 'run' | 'query' | 'beginTransaction' | 'commitTransaction' | 'rollbackTransaction'>

const bind = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p))

/**
 * One statement per item, `--` comments removed. The plugin splits only on ";\n" and runs one statement per part,
 * so a comment after a ";" would silently drop the next statement. ponytail: a plain split, so no string literal in
 * `execAsync` SQL may hold ";" or "--" (none does: it runs the fixed schema and upgrade SQL only).
 */
export const statements = (sql: string) =>
  sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)

/**
 * `Db` over one connection. Every call passes `transaction: false`: the plugin wraps each call in its own
 * transaction by default, and `withTransactionAsync` already holds one around them.
 */
export function toDb(c: Connection): Db {
  return {
    execAsync: async (sql) => { for (const s of statements(sql)) await c.execute(s, false) },
    runAsync: (sql, params) => c.run(sql, bind(params), false),
    getFirstAsync: async <T>(sql: string, params?: unknown[]) => ((await c.query(sql, bind(params))).values?.[0] ?? null) as T | null,
    getAllAsync: async <T>(sql: string, params?: unknown[]) => ((await c.query(sql, bind(params))).values ?? []) as T[],
    // expo-sqlite's shape: roll back on any error, then throw it.
    withTransactionAsync: async (fn) => {
      await c.beginTransaction()
      try {
        await fn()
        await c.commitTransaction()
      } catch (e) {
        await c.rollbackTransaction().catch(() => {})
        throw e
      }
    },
  }
}

let opened: Promise<Db> | null = null

/**
 * The device database, opened once per process. The native connection outlives a page reload, so an existing
 * one is retrieved, never created twice. A failed open is not kept: the next call tries again (the offline
 * reading path depends on it).
 */
export function deviceDb(): Promise<Db> {
  return (opened ??= open().catch((e: unknown) => {
    opened = null
    throw e
  }))
}

async function open(): Promise<Db> {
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite')
  const sqlite = new SQLiteConnection(CapacitorSQLite)
  // After a page reload the plugin's JS list is empty but the native connection is still open:
  // `checkConnectionsConsistency` closes native connections the JS list does not know, so a create cannot
  // fail with "Connection … already exists".
  const consistent = (await sqlite.checkConnectionsConsistency()).result
  const known = consistent && (await sqlite.isConnection(DB_NAME, false)).result
  const c = known ? await sqlite.retrieveConnection(DB_NAME, false) : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  if (!(await c.isDBOpen()).result) await c.open()
  return toDb(c)
}
