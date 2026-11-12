import { useState, type ChangeEvent } from 'react'
// ponytail: deep import of apps/mobile source, as V2ReaderHost's (#1128, ADR-032).
import { addOpened, emptyLibrary, parseLibrary, type LibraryEntry } from '../../../../mobile/src/lib/v2reader/library.mjs'
import { V2ReaderHost, type V2HostBook } from '../../components/reader/V2ReaderHost'
import { readItem, writeItem } from '../../lib/safeLocalStorage'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * The V2 reader on the dev server only (R5, #1037): V2ReaderHost with the book from a file input and a
 * local library in localStorage. The production route (#1225) is the same host with a V2 file's bytes.
 */

const LIBRARY_KEY = 'v2reader:library'
/** The stored library; null when one is stored but does not parse: never written over then (#1081). */
const readLibrary = () => {
  const text = readItem(LIBRARY_KEY)
  return text === null ? emptyLibrary() : parseLibrary(text)
}

export default function V2ReaderDevPage() {
  const { t } = useTranslation()
  const [book, setBook] = useState<V2HostBook | null>(null)
  // null: the stored library is corrupt (left as is, said on screen).
  const [books, setBooks] = useState<LibraryEntry[] | null>(() => readLibrary()?.books ?? null)

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // the same file can be picked again
    if (file) setBook({ bytes: await file.arrayBuffer(), name: file.name })
  }

  return (
    <V2ReaderHost
      book={book}
      dev
      idleHeading={t('v2Reader.pick')}
      toolbar={<input type="file" accept=".epub,.mobi,.azw3,.azw,.fb2,.fbz,.cbz,.pdf,application/epub+zip,application/pdf" onChange={pick} aria-label="Pick EPUB" />}
      onOpened={(m, originalName) => {
        const stored = readLibrary()
        if (!stored) return setBooks(null)
        const { lib } = addOpened(stored, { ...m.book, title: m.title, author: m.author, originalName })
        writeItem(LIBRARY_KEY, JSON.stringify(lib))
        setBooks(lib.books)
      }}
    >
      {books === null
        ? <p role="alert" style={{ margin: 0 }}>{t('v2Reader.libraryCorrupt', { key: LIBRARY_KEY })}</p>
        : <ul data-testid="v2-library" style={{ margin: 0 }}>
            {books.map((b) => <li key={b.id}>{b.title}</li>)}
          </ul>}
    </V2ReaderHost>
  )
}
