// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { applyAlignment } from './alignment.mjs'

beforeEach(() => {
  document.head.innerHTML = '<style>.publisher { text-align: justify !important; }</style>'
  document.body.innerHTML = '<p id="plain">Plain</p><p class="publisher" id="class">Class</p>'
    + '<p id="inline" style="text-align: right !important; color: red;">Inline</p>'
    + '<div id="div" class="publisher">Div text</div><h2 style="text-align:left">Heading</h2>'
})

describe('reader alignment', () => {
  it('changes publisher class, inline-important and div text across consecutive choices', () => {
    for (const [choice, expected] of [['center', 'center'], ['left', 'start'], ['justify', 'justify']]) {
      applyAlignment(document, choice)
      for (const id of ['plain', 'class', 'inline', 'div']) {
        const el = document.getElementById(id)!
        expect(getComputedStyle(el).textAlign).toBe(expected)
        expect(el.style.getPropertyPriority('text-align')).toBe('important')
      }
    }
    expect(document.querySelector('h2')!.style.textAlign).toBe('left')
    expect(document.getElementById('inline')!.style.color).toBe('red')
  })

  it('restores the original values and priorities when returning to book, including after a second round', () => {
    for (let round = 0; round < 2; round++) {
      applyAlignment(document, 'center')
      applyAlignment(document, 'left')
      applyAlignment(document, 'book')
      expect(document.getElementById('plain')!.style.getPropertyValue('text-align')).toBe('')
      expect(document.getElementById('class')!.style.getPropertyValue('text-align')).toBe('')
      expect(document.getElementById('inline')!.style.getPropertyValue('text-align')).toBe('right')
      expect(document.getElementById('inline')!.style.getPropertyPriority('text-align')).toBe('important')
      expect(getComputedStyle(document.getElementById('div')!).textAlign).toBe('justify')
    }
  })

  it('handles another section independently and treats invalid choices as book', () => {
    const next = document.implementation.createHTMLDocument()
    next.body.innerHTML = '<div style="text-align:left">Next chapter</div>'
    applyAlignment(document, 'center')
    applyAlignment(next, 'center')
    applyAlignment(document, 'book')
    expect(next.querySelector('div')!.style.textAlign).toBe('center')
    applyAlignment(next, 'center; color:red')
    expect(next.querySelector('div')!.style.textAlign).toBe('left')
    expect(next.querySelector('div')!.style.getPropertyPriority('text-align')).toBe('')
  })
})
