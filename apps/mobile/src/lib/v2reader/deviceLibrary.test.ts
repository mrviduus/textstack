import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { memoryDb } from './sqliteShim'

// deviceLibrary loads expo-sqlite with a plain `require`, which vi.mock does not reach: seed Node's cache.
let opens = 0
const req = createRequire(import.meta.url)
const sqlitePath = req.resolve('expo-sqlite')
req.cache[sqlitePath] = {
  id: sqlitePath, filename: sqlitePath, loaded: true,
  exports: { openDatabaseAsync: async () => { if (opens++ === 0) throw new Error('disk busy'); return memoryDb() } },
} as never

describe('device V2 local library', () => {
  it('deviceLocalLibrary_FirstOpenFails_NextCallOpensAgain', async () => {
    const { deviceLocalLibrary } = await import('./deviceLibrary')
    await expect(deviceLocalLibrary().books()).rejects.toThrow('disk busy')
    expect(await deviceLocalLibrary().books()).toEqual([])
    expect(opens).toBe(2)
  })
})
