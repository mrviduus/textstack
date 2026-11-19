// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyFontFamily } from './fonts.mjs'

describe('reader fonts', () => {
  it('applies brand choices over publisher fonts while preserving emphasis and code', () => {
    document.body.innerHTML = '<h1 style="font-family:Georgia!important">Title</h1><p style="font-family:Arial!important"><strong>Bold</strong><em>Italic</em></p>'
      + '<pre style="font-family:monospace"><code><span>Code</span></code></pre>'
    const boldWeight = getComputedStyle(document.querySelector('strong')!).fontWeight
    for (const [fontFamily, expected] of [['serif', 'Literata'], ['sans', 'TextStack Source Sans 3']]) {
      applyFontFamily(document, { fontFamily })
      for (const el of document.querySelectorAll('p, strong, em')) {
        expect((el as HTMLElement).style.fontFamily).toContain(expected)
        expect((el as HTMLElement).style.getPropertyPriority('font-family')).toBe('important')
      }
      expect(document.querySelector('pre')!.style.fontFamily).toBe('monospace')
      expect(document.querySelector('h1')!.style.fontFamily).toBe('Georgia')
      expect(document.querySelector('code span')!.getAttribute('style')).toBeNull()
      expect(getComputedStyle(document.querySelector('strong')!).fontWeight).toBe(boldWeight)
      expect(getComputedStyle(document.querySelector('em')!).fontStyle).toBe('italic')
    }
  })

  it('restores the original code face when leaving the accessibility font', () => {
    document.body.innerHTML = '<h1 style="font-family:Georgia!important">Title</h1><pre style="font-family:Courier!important"><code>Code</code></pre>'
    applyFontFamily(document, { fontFamily: 'dyslexic' })
    expect(document.querySelector('pre')!.style.fontFamily).toContain('OpenDyslexic')
    applyFontFamily(document, { fontFamily: 'serif' })
    expect(document.querySelector('pre')!.style.fontFamily).toBe('Courier')
    expect(document.querySelector('pre')!.style.getPropertyPriority('font-family')).toBe('important')
    expect(document.querySelector('code')!.style.fontFamily).toBe('')
    expect(document.querySelector('h1')!.style.fontFamily).toBe('Georgia')
    expect(document.querySelector('h1')!.style.getPropertyPriority('font-family')).toBe('important')
  })
})
