import ReaderScreen from '../../../../src/components/reader/ReaderScreen'

/**
 * The reader route: the V2 reader (ADR-032), on every platform (M6, D4: iOS has no host yet). Every entry point
 * lands here; the chapter slug is ignored, the book opens at its synced place.
 */
export default function UserBookReaderScreen() {
  return <ReaderScreen />
}
