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

describe('initialPdfJump — front matter (Compound Effect: first chapter at p.5)', () => {
  it('a saved page 1 jumps back from the bootstrap page 5 instead of staying (and saving 5)', () => {
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 5, chapterEndPage: 40, firstChapter: true, resumePage: 1 })).toEqual({ kind: 'jump', page: 1 })
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 5, chapterEndPage: 40, firstChapter: true, resumePage: 2 })).toEqual({ kind: 'jump', page: 2 })
  })

  it('a page past the document jumps to the last page, not beyond', () => {
    expect(initialPdfJump({ resumeReady: true, chapterStartPage: 150, chapterEndPage: null, resumePage: 200, pageCount: 195 })).toEqual({ kind: 'jump', page: 195 })
  })
})

describe('wiring', () => {
  const pdfHook = readFileSync(resolve(__dirname, '../components/reader/useReaderPdf.ts'), 'utf8')
  it('the shell decides the first PDF jump through initialPdfJump, with no start-page shortcut', () => {
    const start = pdfHook.indexOf('const maybeInitialPdfJump = useCallback(')
    const body = pdfHook.slice(start, pdfHook.indexOf('}, [', start))
    expect(body).toContain('initialPdfJump(')
    expect(body).not.toContain('originalInitialPage != null && !originalResumeReady')
    expect(body).toContain("if (first.kind === 'wait') return")
    // Front matter belongs to the first chapter; the page count bounds the target.
    expect(body).toContain('firstChapter: !originalChapterPicked && isFirstPagedChapter(chapters, idx)')
    expect(body).toContain('pageCount: pdfNumPagesRef.current')
  })

  it('the newer-page check uses the same chapter range as the first jump', () => {
    const start = pdfHook.indexOf('const inChapter = resolvePdfResumePage(')
    expect(pdfHook.slice(start, pdfHook.indexOf('}) === page', start))).toContain('firstChapter: isFirstPagedChapter(chapters, idx)')
  })
})
