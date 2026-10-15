import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the R3 fixes that live in native-view components (ReaderShell, PdfReaderChrome):
 * react-dom cannot mount them. The decisions are tested in firstRun (readerBackAction),
 * readerSessionGate, bookLanguage, rebuildRestore, sessionMath and progressRestore; L4 (a failed PDF
 * refresh is not silent) is a behaviour test in components/reader/useReaderPdfEngine.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const shell = read('src/components/reader/ReaderShell.tsx')
const pdfChrome = read('src/components/reader/PdfReaderChrome.tsx')

describe('M3 — Android back with the word toolbar open closes the toolbar', () => {
  it('the back handler asks readerBackAction and closes the selection itself', () => {
    const start = shell.indexOf("BackHandler.addEventListener('hardwareBackPress'")
    const body = shell.slice(start, shell.indexOf('return () => sub.remove()', start))
    expect(body).toContain('selectionOpen: !!selection')
    expect(body).toMatch(/if \(action === 'close-selection'\) \{ closeSelection\(\); return true \}/)
  })

  it('the toolbar X and back share one close', () => {
    expect(shell).toContain('onClose={closeSelection}')
  })
})

describe('M7 — the PDF page input is never under the keyboard', () => {
  it('the input lives in a Modal (its own window), not the bottom-pinned footer', () => {
    const modal = pdfChrome.indexOf('<Modal visible={typing}')
    expect(modal).toBeGreaterThan(-1)
    expect(pdfChrome.indexOf('<TextInput')).toBeGreaterThan(modal)
    expect(pdfChrome.indexOf('<TextInput')).toBeLessThan(pdfChrome.indexOf('</Modal>'))
    expect(pdfChrome).toContain('onRequestClose={closeInput}')
  })
})
