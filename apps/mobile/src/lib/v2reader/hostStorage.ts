// What the V2 reader's host keeps on the device (R2 dev route, README "Host responsibilities"), under
// <documents>/v2/:
//   staging/<n>.epub      a picked file until the page has opened it
//   books/<sha256>.epub   the retained copy; identical bytes are kept once
//   library.json          library.mjs's shape
//   store/<sha256>.json   the page's `store` payload for that file, verbatim
import { createWriteQueue } from '../sessionWrites'
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
 * before renaming: a kill between the two leaves only the complete tmp, which `readRecovering` reads.
 * A kill after the tmp write but before that delete leaves the old target beside a complete tmp; the
 * old target wins and that save is lost, which is acceptable because its caller never saw it succeed.
 */
export async function writeAtomically(files: V2Files, name: string, text: string): Promise<void> {
  try {
    await files.write(`${name}.tmp`, text)
  } catch (e) {
    // A failed write (ENOSPC) leaves an empty or partial tmp: drop it. Only here — after a failed
    // move the tmp may be the one complete copy left.
    try { files.remove(`${name}.tmp`) } catch { /* best effort; the write's error is the one to report */ }
    throw e
  }
  await files.move(`${name}.tmp`, name)
}

/** The target when it exists (a tmp beside it is ignored, finished or not), else the tmp. */
export async function readRecovering(files: V2Files, name: string): Promise<string | null> {
  return (await files.read(name)) ?? (await files.read(`${name}.tmp`))
}

/** The retained copy of the file with this (already normalised) sha256. */
export const bookFile = (sha256: string) => `books/${sha256}.epub`

export function createV2Storage(files: V2Files) {
  // ponytail: one in-process queue for every read and write: two imports read-modify-write
  // library.json in turn, two saves of one key never share a .tmp, and no read lands between a
  // move's delete and rename. Does not cover a second process or a second storage instance;
  // per-file queues if work ever waits visibly. sha256Key runs inside each job, so a bad key from
  // the page is that job's rejection, never a throw out of the message handler.
  const queue = createWriteQueue()
  const readLibrary = async () => parseLibrary((await readRecovering(files, 'library.json')) ?? '') ?? emptyLibrary()

  return {
    books: (): Promise<LibraryBook[]> => queue.run(async () => (await readLibrary()).books),

    /**
     * The opened file into the library; resolves to the retained file and the library's books. A
     * staged file becomes the retained copy unless those bytes are already retained. The copy lands
     * before the entry, so a kill between the two leaves a file that the next import of the same
     * bytes adopts, never an entry without its file. On an error after this call's move, the copy
     * stays only if the library (as `books()` would read it) lists those bytes: a complete
     * library.json.tmp beside a missing target does, an old target that survived a failed move does
     * not, and an unreadable library keeps the copy. So a failed import leaves no retained copy the
     * library does not list. The page keeps the book open and may still save its `store` payload; a
     * later import of the same bytes reuses it.
     */
    addOpened: (book: { sha256: string; size: number; title: string; author: string; originalName: string }, staged: string | null) =>
      queue.run(async () => {
        const sha256 = sha256Key(book.sha256)
        const retained = bookFile(sha256)
        const moved = staged !== null && !files.exists(retained)
        if (moved) await files.move(staged, retained)
        else if (staged) files.remove(staged)
        try {
          const { lib } = addOpened(await readLibrary(), { ...book, sha256 })
          await writeAtomically(files, 'library.json', JSON.stringify(lib))
          return { retained, books: lib.books as LibraryBook[] }
        } catch (e) {
          // Keep the copy whenever the library lists it, so never an entry without its file.
          const listed = moved && (await readLibrary().then((l) => (l.books as LibraryBook[]).some((b) => b.sha256 === sha256), () => true))
          if (moved && !listed) try { files.remove(retained) } catch { /* best effort; rethrow the real error */ }
          throw e
        }
      }),

    /** A staged file the page could not open: README "open-failed — must not keep the file". */
    dropStaged: (staged: string) => queue.run(async () => files.remove(staged)),

    readStore: (key: string) => queue.run(() => readRecovering(files, `store/${sha256Key(key)}.json`)),

    writeStore: (key: string, json: string) => queue.run(() => writeAtomically(files, `store/${sha256Key(key)}.json`, json)),
  }
}

export type V2Storage = ReturnType<typeof createV2Storage>
