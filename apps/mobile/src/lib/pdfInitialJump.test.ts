import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialPdfJump } from './pdfInitialJump'

/**
 * R4 bug 2: with a known chapter start page the gate went live the moment the viewer was ready,
 * before the device's own page had been read — so reopening at p.23 of a chapter starting at p.17
 * landed on p.17, and the first page report saved it. The device read never touches the network,
 * so waiting for it is waiting for SQLite.
 */
describe('initialPdfJump', () => {
  it('a known start page still waits for the device page', () => {
    expect(initialPdfJump({ resumeReady: false, chapterStartPage: 17, chapterEndPage: 30, resumePage: null })).toEqual({ kind: 'wait' })
    expect(initialPdfJump({ resumeReady: false, chapterStartPage: null, chapterEndPage: null, resumePage: null })).toEqual({ kind: 'wait' })
  })

  it('the device page inside the chapter wins over its start', () => {
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 17, chapterEndPage: 30, resumePage: 23 })).toEqual({ kind: 'jump', page: 23 })
  })

  it('a device page outside the chapter → the chapter start (the reader picked this chapter)', () => {
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 17, chapterEndPage: 30, resumePage: 40 })).toEqual({ kind: 'stay', page: 17 })
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 17, chapterEndPage: 30, resumePage: null })).toEqual({ kind: 'stay', page: 17 })
  })

  it('no chapter page: the device page, page 1 needs no jump', () => {
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: null, chapterEndPage: null, resumePage: 9 })).toEqual({ kind: 'jump', page: 9 })
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: null, chapterEndPage: null, resumePage: null })).toEqual({ kind: 'stay', page: 1 })
  })
})

describe('wiring', () => {
  const shell = readFileSync(resolve(__dirname, '../components/reader/ReaderShell.tsx'), 'utf8')
  it('the shell decides the first PDF jump through initialPdfJump, with no start-page shortcut', () => {
    const start = shell.indexOf('const maybeInitialPdfJump = useCallback(')
    const body = shell.slice(start, shell.indexOf('}, [', start))
    expect(body).toContain('initialPdfJump(')
    expect(body).not.toContain('originalInitialPage != null && !originalResumeReady')
    expect(body).toContain("if (first.kind === 'wait') return")
  })
})
