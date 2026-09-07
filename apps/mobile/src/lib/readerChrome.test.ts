import { describe, it, expect } from 'vitest'
import {
  readerChromeCss,
  readerChromeInjectionJs,
  readerDocumentKey,
  latchReaderChrome,
  readerChromeChanged,
  readerTypographyCss,
  readerTypographyInjectionJs,
  readerTypographyChanged,
  fontFaceKey,
  type ReaderChrome,
  type ReaderTypography,
} from './readerChrome'

const chrome: ReaderChrome = {
  safeArea: { top: 24, bottom: 16 },
  backgroundColor: '#FBF7F0',
  textColor: '#1A1A1A',
}

const typography: ReaderTypography = {
  fontFamily: 'Georgia, serif',
  fontSize: 18,
  lineHeight: 1.6,
  textAlign: 'left',
}

const doc = {
  chapterSlug: '1-book-i',
  fontFaceKey: 'std',
  overlayV2: true,
  htmlLength: 42_000,
}

describe('readerDocumentKey', () => {
  it('ignores safe-area insets', () => {
    // The regression. Insets change every time the status bar hides, which
    // useReaderBars does 3s after open and on every scroll-direction change —
    // so the document was rebuilt many times per session with no user action,
    // discarding every chapter infinite scroll had appended.
    expect(readerDocumentKey(doc)).toBe(readerDocumentKey({ ...doc }))
  })

  it('ignores typography', () => {
    // The inversion of the assertion this file used to make. Typography WAS a
    // document input, on the grounds that a rebuild plus the existing scroll
    // restore was the behaviour those settings already had. It was not: the
    // rebuilt document is built from the ROUTE chapter, and the restore
    // re-applied the reader's fraction of whatever chapter infinite scroll had
    // carried them into — 55% of chapter two became 74% of chapter one, and the
    // debounced save wrote it over their real position.
    //
    // Font size, line height, alignment and the serif/sans family are ordinary
    // CSS and are injected into the live document instead.
    for (const t of [
      { fontSize: 20 },
      { lineHeight: 1.8 },
      { textAlign: 'justify' },
      { fontFaceKey: fontFaceKey('Georgia, serif') },
    ]) {
      expect(readerDocumentKey({ ...doc, ...t })).toBe(readerDocumentKey(doc))
    }
  })

  it('changes for the one typography input that cannot be injected', () => {
    // OpenDyslexic is 150KB of base64 that buildFontFace emits only when it is
    // selected, so moving to or from that face is a different document.
    expect(fontFaceKey('OpenDyslexic, sans-serif')).toBe('dyslexic')
    expect(fontFaceKey('Georgia, serif')).toBe('std')
    expect(readerDocumentKey({ ...doc, fontFaceKey: 'dyslexic' })).not.toBe(readerDocumentKey(doc))
  })

  it('changes when the chapter changes', () => {
    expect(readerDocumentKey({ ...doc, chapterSlug: '2-book-ii' })).not.toBe(readerDocumentKey(doc))
    // Same slug, different content — an edited or re-parsed chapter.
    expect(readerDocumentKey({ ...doc, htmlLength: 43_000 })).not.toBe(readerDocumentKey(doc))
  })
})

describe('template and injection agree', () => {
  it('carry the same padding', () => {
    // 24 + 16 edge padding, 16 at the sides.
    expect(readerChromeCss(chrome)).toContain('40px 16px 32px 16px')
    expect(readerChromeInjectionJs(chrome)).toContain('40px 16px 32px 16px')
  })

  it('carry the same colours', () => {
    for (const out of [readerChromeCss(chrome), readerChromeInjectionJs(chrome)]) {
      expect(out).toContain('#FBF7F0')
      expect(out).toContain('#1A1A1A')
    }
  })

  it('produces injectable JS with no template-literal terminator', () => {
    expect(readerChromeInjectionJs(chrome)).not.toContain('`')
  })

  it('carry the same typography', () => {
    const css = readerTypographyCss(typography)
    const js = readerTypographyInjectionJs(typography, 7)
    for (const out of [css, js]) {
      expect(out).toContain('Georgia, serif')
      expect(out).toContain('18px')
      expect(out).toContain('1.6')
      expect(out).toContain('left')
    }
  })

  it('hands the restore id to the WebView so the write gate can shut', () => {
    // A typography reflow scrolls the document to keep the reader in place, and
    // that scroll is indistinguishable from the reader's own on the way back.
    // It is a restore, so it carries an id and is acknowledged like one.
    expect(readerTypographyInjectionJs(typography, 7)).toContain('__textstackApplyTypography')
    expect(readerTypographyInjectionJs(typography, 7)).toContain(', 7)')
  })

  it('produces injectable typography JS with no template-literal terminator', () => {
    expect(readerTypographyInjectionJs(typography, 1)).not.toContain('`')
  })
})

describe('readerTypographyChanged', () => {
  it('is true on first application and false for an identical value', () => {
    expect(readerTypographyChanged(null, typography)).toBe(true)
    expect(readerTypographyChanged(typography, { ...typography })).toBe(false)
  })

  it('notices each of the four', () => {
    expect(readerTypographyChanged(typography, { ...typography, fontSize: 20 })).toBe(true)
    expect(readerTypographyChanged(typography, { ...typography, lineHeight: 1.8 })).toBe(true)
    expect(readerTypographyChanged(typography, { ...typography, textAlign: 'justify' })).toBe(true)
    expect(readerTypographyChanged(typography, { ...typography, fontFamily: 'system-ui' })).toBe(true)
  })
})

describe('latchReaderChrome', () => {
  it('keeps the larger inset when the status bar hides', () => {
    expect(latchReaderChrome(chrome, { ...chrome, safeArea: { top: 0, bottom: 16 } }).safeArea.top).toBe(24)
  })

  it('lets a theme change through', () => {
    expect(latchReaderChrome(chrome, { ...chrome, backgroundColor: '#111' }).backgroundColor).toBe('#111')
  })
})

describe('readerChromeChanged', () => {
  it('is true on first application and false for an identical value', () => {
    expect(readerChromeChanged(null, chrome)).toBe(true)
    expect(readerChromeChanged(chrome, { ...chrome, safeArea: { ...chrome.safeArea } })).toBe(false)
  })
})
