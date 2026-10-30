// What the V2 reader's host keeps on the device (R2 dev route, README "Host responsibilities"), under
// <documents>/v2/:
//   staging/<n>.epub      a picked file until the page has opened it
//   books/<sha256>.epub   the retained copy; identical bytes are kept once
//   library.json          library.mjs's shape
//   store/<sha256>.json   the page's `store` payload for that file, verbatim
import { addOpened, emptyLibrary, parseLibrary } from './library.mjs'

/** The file operations this needs, by name relative to the v2 root: expo-file-system on a device. */
export interface V2Files {
  read(name: string): Promise<string | null>
  write(name: string, text: string): Promise<void>
  /** Overwrites `to`. */
  move(from: string, to: string): Promise<void>
  exists(name: string): boolean
  remove(name: string): void
}

export interface LibraryBook {
  id: string
  sha256: string
  size: number
  title: string
  author: string
  originalName: string
  importedAt: number
  openedAt: number
}

/** The page's `sha256()` emits lower case and every lookup compares bytes, so a key is lower-cased
 *  before it names a file or matches an entry. Anything but 64 hex digits never names a file. */
export function sha256Key(hex: string): string {
  const key = hex.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`not a sha256: ${hex.slice(0, 80)}`)
  return key
}

/** A v4 UUID (122 random bits from the platform CSPRNG) as the page's hex nonce. */
export function nonceFromUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('nonce source is not a UUID')
  return hex
}

/**
 * Write `name.tmp`, then move it over `name`. expo-file-system's overwriting move deletes the target
 * before renaming, so a kill in between leaves only the complete tmp: `readRecovering` reads it.
 */
export async function writeAtomically(files: V2Files, name: string, text: string): Promise<void> {
  await files.write(`${name}.tmp`, text)
  await files.move(`${name}.tmp`, name)
}

/** A tmp beside an existing target is a write that never finished, and is ignored. */
export async function readRecovering(files: V2Files, name: string): Promise<string | null> {
  return (await files.read(name)) ?? (await files.read(`${name}.tmp`))
}

export function createV2Storage(files: V2Files) {
  // ponytail: one in-process chain for every read and write: two imports read-modify-write
  // library.json in turn, two saves of one key never share a .tmp, and no read lands between a
  // move's delete and rename. Does not cover a second process or a second storage instance;
  // per-file chains if work ever queues visibly.
  let tail: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => {})
    return run
  }

  const readLibrary = async () => parseLibrary((await readRecovering(files, 'library.json')) ?? '') ?? emptyLibrary()

  // Every entry point is async: a key from the page that is not a sha256 rejects instead of
  // throwing out of the message handler before its caller's .catch is attached.
  return {
    bookName: async (sha256: string) => `books/${sha256Key(sha256)}.epub`,

    books: (): Promise<LibraryBook[]> => serially(async () => (await readLibrary()).books),

    /**
     * The opened file into the library. A staged file becomes the retained copy unless those bytes are
     * already retained. The copy lands before the entry, so a kill between the two leaves a file that
     * the next import of the same bytes adopts, never an entry without its file.
     */
    async addOpened(book: { sha256: string; size: number; title: string; author: string; originalName: string }, staged: string | null) {
      const sha256 = sha256Key(book.sha256)
      return serially(async () => {
        if (staged) {
          if (files.exists(`books/${sha256}.epub`)) files.remove(staged)
          else await files.move(staged, `books/${sha256}.epub`)
        }
        const { lib, entry, existing } = addOpened(await readLibrary(), { ...book, sha256 })
        await writeAtomically(files, 'library.json', JSON.stringify(lib))
        return { entry: entry as LibraryBook, existing: existing as boolean }
      })
    },

    /** A staged file the page could not open: README "open-failed — must not keep the file". */
    dropStaged: (staged: string) => files.remove(staged),

    async readStore(key: string) {
      const name = `store/${sha256Key(key)}.json`
      return serially(() => readRecovering(files, name))
    },

    async writeStore(key: string, json: string) {
      const name = `store/${sha256Key(key)}.json`
      return serially(() => writeAtomically(files, name, json))
    },
  }
}

export type V2Storage = ReturnType<typeof createV2Storage>
