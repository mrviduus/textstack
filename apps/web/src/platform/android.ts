// SPIKE #1629 (throwaway, never merged): the Android side of the Platform seam, just enough for the five checks.
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite'
import { SocialLogin } from '@capgo/capacitor-social-login'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'

const DB = 'textstack-v2'
const sqlite = new SQLiteConnection(CapacitorSQLite)
let db: Promise<SQLiteDBConnection> | null = null
export const log: string[] = []
const say = (s: string) => { log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); console.log('[spike]', s) }

/** Pass 2: today's expo-sqlite file (files/SQLite/textstack-v2) copied, not moved, to the plugin's place (databases/textstack-v2SQLite.db). */
export function openLibrary(): Promise<SQLiteDBConnection> {
  return (db ??= openOnce())
}
async function openOnce(): Promise<SQLiteDBConnection> {
  // The plugin throws "No databases available" on an empty list.
  const have = (await sqlite.getDatabaseList().catch(() => ({ values: [] as string[] }))).values ?? []
  say(`plugin databases: ${JSON.stringify(have)}`)
  if (!have.includes(`${DB}SQLite.db`)) {
    const old = await Filesystem.readdir({ path: 'SQLite', directory: Directory.Data }).catch((e) => ({ files: [], e }))
    say(`files/SQLite: ${JSON.stringify((old as { files: { name: string; size: number }[] }).files.map((f) => `${f.name}:${f.size}`))}`)
    await sqlite.addSQLiteSuffix('files/SQLite', [DB])
    say('copied expo db into databases/')
  }
  const c = await sqlite.createConnection(DB, false, 'no-encryption', 1, false)
  await c.open()
  return c
}

export interface DeviceBook { id: string; title: string; author: string; sha256: string | null; size: number | null; format: string | null; fileOk: boolean }

export async function deviceBooks(): Promise<DeviceBook[]> {
  const d = await openLibrary()
  const rows = (await d.query('SELECT id, title, author, sha256, size, format FROM books ORDER BY opened_at DESC')).values ?? []
  const out: DeviceBook[] = []
  for (const r of rows) {
    const st = r.sha256 ? await Filesystem.stat({ path: `v2/books/${r.sha256}.epub`, directory: Directory.Data }).catch(() => null) : null
    out.push({ ...r, fileOk: !!st && st.size > 0 })
  }
  return out
}

export async function counts(): Promise<Record<string, number>> {
  const d = await openLibrary()
  const c: Record<string, number> = {}
  for (const t of ['books', 'annotations', 'reading_state', 'reading_sessions', 'vocabulary', 'outbox', 'meta']) {
    c[t] = Number((await d.query(`SELECT count(*) AS n FROM ${t}`)).values?.[0]?.n ?? -1)
  }
  return c
}

/** Pass 1: the retained file served to this WebView by Capacitor's local server (no network, no token). */
export async function bookBytes(sha256: string): Promise<ArrayBuffer> {
  const { uri } = await Filesystem.getUri({ path: `v2/books/${sha256}.epub`, directory: Directory.Data })
  const url = Capacitor.convertFileSrc(uri)
  say(`fetch ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`book file ${res.status}`)
  return res.arrayBuffer()
}

const WEB_CLIENT_ID = '726577729877-0lc197ngqf9qb297tvgh22q2k7g72l4l.apps.googleusercontent.com'
export const API = (import.meta.env.VITE_API_URL as string | undefined) || 'https://textstack.app/api'

/** Pass 4: native Google → id token → POST /auth/google in mobile mode → tokens in secure storage → a bearer call. */
export async function googleSignIn(): Promise<string> {
  await SocialLogin.initialize({ google: { webClientId: WEB_CLIENT_ID } })
  const r = await SocialLogin.login({ provider: 'google', options: {} })
  const idToken = (r.result as { idToken?: string | null }).idToken
  say(`google idToken: ${idToken ? idToken.slice(0, 16) + '…' : 'none'}`)
  if (!idToken) throw new Error('no id token')
  const login = await fetch(`${API}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client': 'mobile' }, body: JSON.stringify({ idToken }) })
  say(`POST /auth/google → ${login.status}`)
  const body = await login.json()
  await SecureStorage.set('accessToken', body.accessToken)
  await SecureStorage.set('refreshToken', body.refreshToken)
  const token = (await SecureStorage.get('accessToken')) as string
  const me = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}`, 'X-Client': 'mobile' } })
  say(`GET /auth/me (bearer, fetch from ${location.origin}) → ${me.status}`)
  return `${body.user?.email ?? '?'} · /auth/me ${me.status}`
}

/** CORS probe: the same call through the WebView's fetch (CORS applies) and through native HTTP (it does not). */
export async function corsProbe(): Promise<string> {
  const a = await fetch(`${API}/health`).then((r) => `fetch ${r.status}`, (e) => `fetch failed: ${e}`)
  const b = await CapacitorHttp.get({ url: `${API}/health` }).then((r) => `native ${r.status}`, (e) => `native failed: ${e}`)
  say(`cors probe: ${a}; ${b}`)
  return `${a}; ${b}`
}
