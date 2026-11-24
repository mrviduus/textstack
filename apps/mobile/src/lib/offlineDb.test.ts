/**
 * The legacy chapter cache leaves existing installs (#1522): its database file is deleted on start, its WAL
 * checkpointed first by a close; an install that never had it is not touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import AsyncStorage from '@react-native-async-storage/async-storage'

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }))

const calls: string[] = []
let fileExists = false
/** Directories on the fake disk. */
const dirs = new Set<string>()

// offlineDb loads both modules with a plain `require`, which vi.mock does not reach: seed Node's cache.
const req = createRequire(import.meta.url)
const seed = (name: string, exports: object) => {
  const path = req.resolve(name)
  req.cache[path] = { id: path, filename: path, loaded: true, exports } as never
}
seed('expo-file-system', {
  Paths: { document: 'doc' },
  File: class { constructor(...parts: string[]) { calls.push(`file ${parts.join('/')}`) } get exists() { return fileExists } },
  Directory: class {
    path: string
    constructor(...parts: string[]) { this.path = parts.join('/') }
    get exists() { return dirs.has(this.path) }
    delete() { dirs.delete(this.path) }
  },
})
seed('expo-sqlite', {
  openDatabaseAsync: async (name: string) => { calls.push(`open ${name}`); return { closeAsync: async () => { calls.push('close') } } },
  deleteDatabaseAsync: async (name: string) => { calls.push(`delete ${name}`) },
})

beforeEach(() => { calls.length = 0 })

describe('dropChapterCache', () => {
  it('an install that has the chapter cache loses it: opened, closed, deleted', async () => {
    fileExists = true
    await (await import('./offlineDb')).dropChapterCache()
    expect(calls).toEqual(['file doc/SQLite/textstack-offline', 'open textstack-offline', 'close', 'delete textstack-offline'])
  })

  it('an install without it is left alone: no database is created', async () => {
    fileExists = false
    await (await import('./offlineDb')).dropChapterCache()
    expect(calls).toEqual(['file doc/SQLite/textstack-offline'])
  })
})

describe('dropOriginalsCache', () => {
  it('dropOriginalsCache_OlderBuildLeftOriginals_FilesIndexAndMarksGoOtherKeysStay', async () => {
    dirs.add('doc/originals')
    for (const k of ['originals:lastUsed', 'offline:deletedOnServer', 'offline:declined']) await AsyncStorage.setItem(k, '{}')
    await (await import('./offlineDb')).dropOriginalsCache()
    expect(dirs.has('doc/originals')).toBe(false)
    expect(await AsyncStorage.getAllKeys()).toEqual(['offline:declined'])
    // Twice (every start): nothing there is nothing to do.
    await (await import('./offlineDb')).dropOriginalsCache()
  })
})
