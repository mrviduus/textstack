// What the V2 reader's host keeps on the device (R2 dev route, README "Host responsibilities"), under
// <documents>/v2/:
//   staging/<n>.epub      a picked file until the page has opened it
//   books/<sha256>.epub   the retained copy; identical bytes are kept once
//   library.json, store/  R2's JSON library: imported into the local library once, then deleted
// Books, positions and highlights live in SQLite (localLibrary.ts, R6); only file bytes are files.
import { createWriteQueue } from '../sessionWrites'
import { entryFor } from '@textstack/shared'
import { parseLibrary, type LibraryEntry } from './library.mjs'

/** What the dev route lists: a book on this device, or one the server holds bytes for (download). */
export interface LibraryBook {
  id: string
  sha256: string
  size: number
  title: string
  author: string
  originalName: string
  importedAt: number
  openedAt: number
  /** False: not imported here; the server holds its bytes (sync.ts `downloadV2Book`). */
  local: boolean
  /**
   * Why it is not synced, shown with "Try again" (localLibrary `unpark`): the park reason (the book
   * and its children are not sent), or a fixed one when its entry or a child's stopped being
   * retried; null otherwise.
   */
  notSynced: string | null
}

/**
 * The rows this storage keeps (localLibrary.ts, R6). Structural, not imported: apps/web type-checked this file
 * without allowJs (its dev page took `nonceFromUuid`) until #1219. Nothing outside mobile imports it now, so
 * importing localLibrary's own types would work; left as is, the shape is the same.
 */
export interface LocalLibrary {
  books(): Promise<LibraryBook[]>
  hasLocalBytes(sha256: string): Promise<boolean>
  addOpened(b: { sha256: string; size: number; title: string; author: string; originalName: string; format: string | null }, newId: () => string): Promise<string>
  readEntry(sha256: string): Promise<string | null>
  writeEntry(sha256: string, json: string, newId: () => string): Promise<void>
  /** Resolves to the sha256s whose store entries the rows now hold. */
  importLegacy(books: LibraryEntry[], storeOf: Map<string, string>, newId: () => string): Promise<string[]>
}

/** The file operations this needs, by name relative to the v2 root: expo-file-system on a device. */
export interface V2Files {
  read(name: string): Promise<string | null>
  /** Overwrites `to`. */
  move(from: string, to: string): Promise<void>
  exists(name: string): boolean
  remove(name: string): void
  /** Copies the file at `uri` (a picker's `content://`) to `to`. */
  copyIn(uri: string, to: string): Promise<void>
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
 * R2 wrote its JSON as `name.tmp` moved over `name`: the target when it exists and passes `ok` (a tmp
 * beside it is ignored then, finished or not), else the tmp if it passes — a kill mid-move left only that,
 * a kill mid-write a target that does not parse (#1081).
 */
export async function readRecovering(files: V2Files, name: string, ok: (text: string) => boolean = () => true): Promise<string | null> {
  for (const n of [name, `${name}.tmp`]) {
    const text = await files.read(n)
    if (text !== null && ok(text)) return text
  }
  return null
}

/**
 * `readRecovering`, and when neither file passes, both kept aside (`<name>.corrupt-<ms>`) with a warning:
 * never deleted, never written over, not read again on every start (#1081).
 */
async function readOrKeepAside(files: V2Files, name: string, ok: (text: string) => boolean): Promise<string | null> {
  const text = await readRecovering(files, name, ok)
  if (text !== null) return text
  const aside = [name, `${name}.tmp`].filter((n) => files.exists(n)).map((n) => [n, `${n}.corrupt-${Date.now()}`])
  for (const [from, to] of aside) await files.move(from, to)
  if (aside.length) console.warn(`[v2] R2 ${name} unreadable, not imported; kept aside as ${aside.map(([, to]) => to).join(', ')}`)
  return null
}

/** The retained copy of the file with this (already normalised) sha256. */
export const bookFile = (sha256: string) => `books/${sha256}.epub`

/**
 * The host's storage: the files here, the rows in the local library (localLibrary.ts, R6). `newId`
 * mints v4 UUIDs (library.mjs's default needs `crypto`, which Hermes lacks: the RN host passes Expo's).
 * The first call imports R2's JSON library (library.json + store/<sha256>.json) into the rows, once,
 * then deletes those files; a failed import is logged and tried again on the next start.
 * `sessionSince` is the V2 epoch guard (`resetSince` on the device): an open whose session ended
 * before its row was queued is refused (#1070: the sign-out wipe may have deleted its file).
 */
export function createV2Storage(files: V2Files, newId: () => string, lib: LocalLibrary, sessionSince: () => () => boolean = () => () => false) {
  // ponytail: one in-process queue for the file side (two imports of the same bytes move one copy).
  // sha256Key runs inside each job, so a bad key from the page is that job's rejection, never a
  // throw out of the message handler.
  const queue = createWriteQueue()
  let migrated: Promise<void> | null = null
  // A failed import is not kept: the next call tries again (reading goes on meanwhile).
  const migrate = () => (migrated ??= queue.run(() => importJsonLibrary(files, lib, newId)).catch((e) => {
    console.warn('[v2] JSON library import failed:', e)
    migrated = null
  }))
  const afterMigration = <T>(fn: () => Promise<T>) => migrate().then(fn)

  return {
    books: (): Promise<LibraryBook[]> => afterMigration(() => lib.books()),

    /**
     * The opened file into the library; resolves to the retained file, the book's id and the
     * library's books. A staged file becomes the retained copy unless those bytes are already
     * retained. The copy lands before the row, so a kill between the two leaves a file that the next
     * import of the same bytes adopts, never a row without its file. A failed row write removes the
     * copy this call moved unless the library lists those bytes (the transaction left no row naming it).
     * The session the open started in must still be current when the row is queued — checked in the
     * tick it is queued, so a sign-out's wipe (queued after its epoch bump) either deletes the row with
     * the file or never sees it (#1070).
     */
    addOpened: (book: { sha256: string; size: number; title: string; author: string; originalName: string; format?: string | null }, staged: string | null) => {
      const over = sessionSince()
      return afterMigration(() => queue.run(async () => {
        const sha256 = sha256Key(book.sha256)
        const retained = bookFile(sha256)
        const moved = staged !== null && !files.exists(retained)
        if (moved) await files.move(staged, retained)
        else if (staged) files.remove(staged)
        try {
          if (over()) throw new Error('the session ended during the open: not added')
          const bookId = await lib.addOpened({ ...book, sha256, format: book.format ?? null }, newId)
          return { retained, bookId, books: await lib.books() }
        } catch (e) {
          const listed = moved && (await lib.hasLocalBytes(sha256).catch(() => true))
          if (moved && !listed) try { files.remove(retained) } catch { /* best effort; rethrow the real error */ }
          throw e
        }
      }))
    },

    /**
     * A picked file (the picker's own URI, no cache copy: #1080 items 4–5) copied straight into `staging/`; resolves to its staged name. A failed
     * copy (a full disk) leaves no partial file behind. Not queued: a big copy must not hold up other writes.
     */
    stagePicked: async (uri: string) => {
      const staged = `staging/${Date.now()}.epub`
      try {
        await files.copyIn(uri, staged)
      } catch (e) {
        try { files.remove(staged) } catch { /* best effort; staging/ is cleared on start; rethrow the real error */ }
        throw e
      }
      return staged
    },

    /** A staged file the page could not open: README "open-failed — must not keep the file". */
    dropStaged: (staged: string) => queue.run(async () => files.remove(staged)),

    readStore: (key: string) => afterMigration(() => lib.readEntry(sha256Key(key))),

    writeStore: (key: string, json: string) => afterMigration(() => lib.writeEntry(sha256Key(key), json, newId)),
  }
}

/**
 * R2's JSON library into the local library, then the files of the entries it now holds deleted
 * (best effort: the import is flagged done), library.json last.
 *
 * #1081: library.json and every store entry are read by `readOrKeepAside` (the tmp when the target does not
 * parse; neither: both kept aside before the import deletes what it holds). Nothing has written these since R6.
 */
async function importJsonLibrary(files: V2Files, lib: LocalLibrary, newId: () => string) {
  const text = await readOrKeepAside(files, 'library.json', (t) => parseLibrary(t) !== null)
  if (text === null) return
  const parsed = parseLibrary(text)!
  const books = (parsed.books as LibraryEntry[]).flatMap((b) => {
    try { return [{ ...b, sha256: sha256Key(b.sha256) }] } catch { return [] }
  })
  const stores = new Map<string, string>()
  for (const b of books) {
    const json = await readOrKeepAside(files, `store/${b.sha256}.json`, (t) => entryFor(t, b) !== null)
    if (json) stores.set(b.sha256, json)
  }
  const held = await lib.importLegacy(books, stores, newId)
  // An unreadable entry is no longer under its name (kept aside above): nothing of it is deleted here.
  for (const name of [...held.map((sha) => `store/${sha}.json`), 'library.json']) {
    for (const f of [name, `${name}.tmp`]) try { files.remove(f) } catch { /* best effort */ }
  }
}

export type V2Storage = ReturnType<typeof createV2Storage>
