import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source guards for the R3 reader fixes the WebView and native views make impossible to drive in
 * CI. The decisions themselves are tested in firstRun, readerSessionGate, bookLanguage,
 * rebuildRestore, sessionMath and progressRestore.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const shell = read('src/components/reader/ReaderShell.tsx')
const pdfHook = read('src/components/reader/useReaderPdf.ts')
const pdfChrome = read('src/components/reader/PdfReaderChrome.tsx')
const en = JSON.parse(read('../../packages/shared/src/i18n/en.json'))

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

describe('L4 — a failed refresh after a PDF 401 is not silent', () => {
  it('a null token shows a toast whose action retries the same recovery', () => {
    const start = pdfHook.indexOf('recoverPdfAuthRef.current = () => {')
    const body = pdfHook.slice(start, pdfHook.indexOf('\n  }\n', start))
    expect(body).toMatch(/if \(tok\) \{[\s\S]*setPdfReloadNonce[\s\S]*return\s*\}/)
    expect(body).toContain("t(language, 'reader.pdfReconnect')")
    expect(body).toContain('onPress: () => recoverPdfAuthRef.current()')
  })

  it('the 401 message runs it, and the copy exists', () => {
    const start = pdfHook.indexOf("data.type === 'pdfAuthExpired'")
    expect(pdfHook.slice(start, start + 500)).toContain('recoverPdfAuthRef.current()')
    expect(en.reader.pdfReconnect).toBeTruthy()
  })
})
