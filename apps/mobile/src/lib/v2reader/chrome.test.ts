// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BAR_PRESS_GRACE_MS, NAV_KEYS, backAction, hidesBarsOnRelocate, navKey, readDir, readKey, readTap } from './chrome.mjs'
import { MAX_SELECTION_PX } from './selection.mjs'

const press = (key: string, o: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean; target?: Element } = {}) =>
  navKey({ key, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, altKey: !!o.alt, metaKey: !!o.meta, target: o.target ?? document.body })

describe('v2 reader navigation keys (page side)', () => {
  it.each([['ArrowLeft'], ['ArrowRight'], ['PageUp'], ['PageDown'], ['Escape']])('navKey_%s_Forwarded', (key) => {
    expect(press(key)).toEqual({ type: 'key', key, shift: false })
  })

  it('navKey_Space_ForwardedAsSpaceWithShift', () => {
    expect(press(' ', { shift: true })).toEqual({ type: 'key', key: 'Space', shift: true })
  })

  it('navKey_NoShiftKeyOnTheEvent_ShiftFalse', () => {
    expect(navKey({ key: 'Escape', target: document.body })).toEqual({ type: 'key', key: 'Escape', shift: false })
  })

  it.each([['a'], ['Enter'], ['Tab'], ['ArrowUp'], ['ArrowDown'], ['Home'], ['Backspace'], ['Space'], ['F5']])('navKey_%s_NeverForwarded', (key) => {
    expect(press(key)).toBeNull()
  })

  it.each([['ctrl'], ['alt'], ['meta']])('navKey_With%s_NotForwarded', (mod) => {
    expect(press('ArrowRight', { [mod]: true })).toBeNull()
  })

  it.each([
    ['input', '<input>'],
    ['textarea', '<textarea></textarea>'],
    ['select', '<select><option>x</option></select>'],
    ['contenteditable', '<div contenteditable="true"><span>x</span></div>'],
    ['contenteditable empty', '<div contenteditable><span>x</span></div>'],
  ])('navKey_TypingInA%s_NotForwarded', (_, html) => {
    document.body.innerHTML = html
    expect(press(' ', { target: document.body.querySelector('span') ?? document.body.firstElementChild! })).toBeNull()
  })

  it('navKey_InContenteditableFalse_Forwarded', () => {
    document.body.innerHTML = '<div contenteditable="false"><span>x</span></div>'
    expect(press('PageDown', { target: document.querySelector('span')! })?.key).toBe('PageDown')
  })

  it('NAV_KEYS_TheClosedList', () => {
    expect([...NAV_KEYS].sort()).toEqual(['ArrowLeft', 'ArrowRight', 'Escape', 'PageDown', 'PageUp', 'Space'])
  })
})

describe('v2 reader chrome readers (hostile payloads)', () => {
  it('readTap_Tap_PointKept', () => {
    expect(readTap({ type: 'tap', x: 12.5, y: 0, extra: 1 })).toEqual({ x: 12.5, y: 0 })
    expect(readTap({ type: 'tap', x: -MAX_SELECTION_PX, y: MAX_SELECTION_PX })).not.toBeNull()
  })

  it.each([
    ['not an object', 'tap'],
    ['null', null],
    ['another type', { type: 'word', x: 1, y: 1 }],
    ['no point (an old page)', { type: 'tap' }],
    ['x a string', { type: 'tap', x: '1', y: 1 }],
    ['y missing', { type: 'tap', x: 1 }],
    ['x NaN', { type: 'tap', x: NaN, y: 1 }],
    ['y Infinity', { type: 'tap', x: 1, y: Infinity }],
    ['x past its bound', { type: 'tap', x: MAX_SELECTION_PX + 1, y: 1 }],
    ['y below its bound', { type: 'tap', x: 1, y: -MAX_SELECTION_PX - 1 }],
    ['x 1e308', { type: 'tap', x: 1e308, y: 1 }],
    ['fields only under __proto__', JSON.parse('{"type":"tap","__proto__":{"x":1,"y":1}}')],
  ])('readTap_%s_Dropped', (_, m) => {
    expect(() => readTap(m)).not.toThrow()
    expect(readTap(m)).toBeNull()
  })

  it.each([
    ['rtl', { dir: 'rtl' }, 'rtl'],
    ['ltr', { dir: 'ltr' }, 'ltr'],
    ['missing', {}, null],
    ['upper case', { dir: 'RTL' }, null],
    ['a number', { dir: 1 }, null],
    ['an object', { dir: { toString: () => 'rtl' } }, null],
    ['null message', null, null],
    ['a string message', 'rtl', null],
  ])('readDir_%s', (_, m, want) => {
    expect(readDir(m)).toBe(want)
  })

  it('readKey_Key_KeyAndShiftOnly', () => {
    expect(readKey({ type: 'key', key: 'PageDown', shift: true, code: 'x' })).toEqual({ key: 'PageDown', shift: true })
  })

  it.each([
    ['another type', { type: 'tap', key: 'Space', shift: false }],
    ['a key off the list', { type: 'key', key: 'a', shift: false }],
    ['the raw space character', { type: 'key', key: ' ', shift: false }],
    ['a list key in other case', { type: 'key', key: 'arrowleft', shift: false }],
    ['an inherited list name', { type: 'key', key: 'includes', shift: false }],
    ['a key that is not a string', { type: 'key', key: ['Space'], shift: false }],
    ['shift missing', { type: 'key', key: 'Space' }],
    ['shift a string', { type: 'key', key: 'Space', shift: 'false' }],
    ['null', null],
    ['fields only under __proto__', JSON.parse('{"type":"key","__proto__":{"key":"Space","shift":false}}')],
  ])('readKey_%s_Dropped', (_, m) => {
    expect(() => readKey(m)).not.toThrow()
    expect(readKey(m)).toBeNull()
  })
})

describe('v2 reader bars on relocate (host)', () => {
  it('scrolledFlow_ReaderMoved_Hides', () => {
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: true, msSinceBarPress: Infinity })).toBe(true)
  })

  it('paginated_OrNotMoved_OrBarControlJustPressed_Keeps', () => {
    expect(hidesBarsOnRelocate({ flow: 'paginated', moved: true, msSinceBarPress: Infinity })).toBe(false)
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: false, msSinceBarPress: Infinity })).toBe(false)
    expect(hidesBarsOnRelocate({ flow: 'scrolled', moved: true, msSinceBarPress: BAR_PRESS_GRACE_MS - 1 })).toBe(false)
  })
})

describe('v2 reader Android back order (#1264)', () => {
  it('offerFirst_ThenTheBook_ThenTheRoute', () => {
    expect(backAction({ offer: true, reading: true })).toBe('close-offer')
    expect(backAction({ offer: true, reading: false })).toBe('close-offer')
    expect(backAction({ offer: false, reading: true })).toBe('close-book')
    expect(backAction({ offer: false, reading: false })).toBe('leave')
  })
})
