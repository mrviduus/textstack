// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  BOOK_CLOSED, CLOSE_BOOK_JS, HOST_MOVE_GRACE_MS, NAV_KEYS, backAction, createHostMoves, hidesBarsOnRelocate, keyAction, navKey,
  readDir, readKey, readRelocate, readTap, readWordTap, reopensOnReady, takenWithoutBook,
} from './chrome.mjs'
import { MAX_SELECTION_PX } from './selection.mjs'

const press = (key: string, o: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean; target?: unknown } = {}) =>
  navKey({ key, shiftKey: !!o.shift, ctrlKey: !!o.ctrl, altKey: !!o.alt, metaKey: !!o.meta, repeat: !!o.repeat, target: 'target' in o ? o.target : document.body })

describe('v2 reader navigation keys (page side)', () => {
  it.each([['ArrowLeft'], ['ArrowRight'], ['PageUp'], ['PageDown'], ['Escape']])('navKey_%s_Forwarded', (key) => {
    expect(press(key)).toEqual({ type: 'key', key, shift: false, repeat: false })
  })

  it('navKey_Space_ForwardedAsSpaceWithShift', () => {
    expect(press(' ', { shift: true })).toEqual({ type: 'key', key: 'Space', shift: true, repeat: false })
  })

  it('navKey_NoShiftOrRepeatOnTheEvent_False', () => {
    expect(navKey({ key: 'Escape', target: document.body })).toEqual({ type: 'key', key: 'Escape', shift: false, repeat: false })
  })

  it('navKey_HeldKey_RepeatTrue', () => {
    expect(press('PageDown', { repeat: true })?.repeat).toBe(true)
  })

  it('navKey_OnTheRootElement_Forwarded', () => {
    expect(press('PageDown', { target: document.documentElement })?.key).toBe('PageDown')
  })

  it.each([['a'], ['Enter'], ['Tab'], ['ArrowUp'], ['ArrowDown'], ['Home'], ['Backspace'], ['Space'], ['F5']])('navKey_%s_NeverForwarded', (key) => {
    expect(press(key)).toBeNull()
  })

  it.each([['ctrl'], ['alt'], ['meta']])('navKey_With%s_NotForwarded', (mod) => {
    expect(press('ArrowRight', { [mod]: true })).toBeNull()
  })

  it.each([['ArrowLeft'], ['ArrowRight']])('navKey_Shift%s_NotForwarded_ItExtendsASelection', (key) => {
    expect(press(key, { shift: true })).toBeNull()
  })

  it.each([
    ['input', '<input>'],
    ['textarea', '<textarea></textarea>'],
    ['select', '<select><option>x</option></select>'],
    ['summary', '<details><summary>x</summary>y</details>'],
    ['button', '<button>x</button>'],
    ['link', '<a href="#x">x</a>'],
    ['video with controls', '<video controls></video>'],
    ['tabindex', '<div tabindex="0">x</div>'],
    ['role button', '<div role="button" tabindex="0">x</div>'],
  ])('navKey_OnA%s_NotForwarded', (_, html) => {
    document.body.innerHTML = html
    expect(press(' ', { target: document.body.firstElementChild!.querySelector('summary') ?? document.body.firstElementChild })).toBeNull()
  })

  it('navKey_ContentEditableBody_NotForwarded', () => {
    document.body.setAttribute('contenteditable', '')
    try { expect(press(' ')).toBeNull() } finally { document.body.removeAttribute('contenteditable') }
  })

  it.each([['no target', undefined], ['the document', document], ['a detached element', document.createElement('div')]])('navKey_%s_NotForwarded', (_, target) => {
    expect(press(' ', { target })).toBeNull()
  })

  it('NAV_KEYS_TheClosedList', () => {
    expect([...NAV_KEYS].sort()).toEqual(['ArrowLeft', 'ArrowRight', 'Escape', 'PageDown', 'PageUp', 'Space'])
  })
})

describe('v2 reader key actions (both hosts)', () => {
  it.each([
    ['ArrowLeft', false, 'ltr', 'prev'],
    ['ArrowRight', false, 'ltr', 'next'],
    ['ArrowLeft', false, 'rtl', 'next'],
    ['ArrowRight', false, 'rtl', 'prev'],
    ['PageUp', false, 'rtl', 'prev'],
    ['PageDown', false, 'rtl', 'next'],
    ['Space', false, 'ltr', 'next'],
    ['Space', true, 'ltr', 'prev'],
    ['Escape', false, 'ltr', 'bars'],
  ] as const)('keyAction_%s_shift%s_%s_%s', (key, shift, dir, want) => {
    expect(keyAction({ key, shift, dir })).toBe(want)
  })

  it('keyAction_UnknownKey_Null', () => {
    expect(keyAction({ key: 'Home' as never, shift: false, dir: 'ltr' })).toBeNull()
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

  it('readKey_Key_KeyShiftRepeatOnly', () => {
    expect(readKey({ type: 'key', key: 'PageDown', shift: true, repeat: false, code: 'x' })).toEqual({ key: 'PageDown', shift: true, repeat: false })
  })

  it.each([
    ['another type', { type: 'tap', key: 'Space', shift: false, repeat: false }],
    ['a key off the list', { type: 'key', key: 'a', shift: false, repeat: false }],
    ['the raw space character', { type: 'key', key: ' ', shift: false, repeat: false }],
    ['a list key in other case', { type: 'key', key: 'arrowleft', shift: false, repeat: false }],
    ['an inherited list name', { type: 'key', key: 'includes', shift: false, repeat: false }],
    ['a key that is not a string', { type: 'key', key: ['Space'], shift: false, repeat: false }],
    ['shift missing', { type: 'key', key: 'Space', repeat: false }],
    ['shift a string', { type: 'key', key: 'Space', shift: 'false', repeat: false }],
    ['repeat missing (an old page)', { type: 'key', key: 'Space', shift: false }],
    ['repeat a number', { type: 'key', key: 'Space', shift: false, repeat: 1 }],
    ['null', null],
    ['fields only under __proto__', JSON.parse('{"type":"key","__proto__":{"key":"Space","shift":false,"repeat":false}}')],
  ])('readKey_%s_Dropped', (_, m) => {
    expect(() => readKey(m)).not.toThrow()
    expect(readKey(m)).toBeNull()
  })
})

describe('v2 reader bars on relocate (host)', () => {
  it('readerMoved_Hides_EitherFlow', () => {
    // One rule: a swipe in paginated flow and a scroll in scrolled flow are both `moved`.
    expect(hidesBarsOnRelocate({ moved: true, msSinceHostMove: Infinity })).toBe(true)
  })

  it('notMoved_OrABarButtonJustMovedIt_Keeps', () => {
    // A re-layout, an open/restore, a sync goTo: the page says moved false.
    expect(hidesBarsOnRelocate({ moved: false, msSinceHostMove: Infinity })).toBe(false)
    expect(hidesBarsOnRelocate({ moved: true, msSinceHostMove: HOST_MOVE_GRACE_MS - 1 })).toBe(false)
    expect(hidesBarsOnRelocate({ moved: true, msSinceHostMove: HOST_MOVE_GRACE_MS })).toBe(true)
  })

  it('hostMoves_FirstRelocateAfterStartIsTheHosts_HoweverLate', () => {
    const moves = createHostMoves()
    expect(moves.onRelocate(1000)).toBe(Infinity) // the reader's own
    moves.start() // a goTo (sync adopt, the offer) or a bar button
    expect(moves.onRelocate(9000)).toBe(0) // its landing, a slow section load later
    expect(moves.onRelocate(9400)).toBe(400) // the snap after it, inside the grace
    expect(moves.onRelocate(20000)).toBe(11000) // the reader scrolling again
  })
})

describe('v2 reader relocate read for the chrome (hostile payloads)', () => {
  it('readRelocate_Valid_Kept', () => {
    expect(readRelocate({ type: 'relocate', fraction: 0.5, index: 3, sections: 9, toc: 'Ch 1', dir: 'rtl', moved: true, cfi: 'x' }))
      .toEqual({ fraction: 0.5, index: 3, sections: 9, toc: 'Ch 1', dir: 'rtl', moved: true })
  })

  it.each([['missing', undefined], ['false', false], ['a string', 'true'], ['1', 1], ['an object', {}]])('readRelocate_moved %s_False', (_, moved) => {
    expect(readRelocate({ type: 'relocate', moved })?.moved).toBe(false)
  })

  it('readWordTap_CentreOfTheRect', () => {
    expect(readWordTap({ type: 'word', word: 'a', rect: { x: 300, y: 100, w: 40, h: 20 } })).toEqual({ x: 320, y: 110 })
  })

  it.each([
    ['another type', { type: 'tap', rect: { x: 1, y: 1, w: 1, h: 1 } }],
    ['no rect', { type: 'word' }],
    ['rect a string', { type: 'word', rect: 'x' }],
    ['x NaN', { type: 'word', rect: { x: NaN, y: 1, w: 1, h: 1 } }],
    ['w missing', { type: 'word', rect: { x: 1, y: 1, h: 1 } }],
    ['w negative', { type: 'word', rect: { x: 1, y: 1, w: -1, h: 1 } }],
    ['x past its bound', { type: 'word', rect: { x: MAX_SELECTION_PX + 1, y: 1, w: 1, h: 1 } }],
    ['w past its bound (centre inside)', { type: 'word', rect: { x: 0, y: 1, w: MAX_SELECTION_PX + 1, h: 1 } }],
    ['null', null],
  ])('readWordTap_%s_Dropped', (_, m) => {
    expect(() => readWordTap(m)).not.toThrow()
    expect(readWordTap(m)).toBeNull()
  })

  it.each([
    ['a toc object', { toc: { a: 1 } }, { toc: '' }],
    ['a toc array', { toc: ['x'] }, { toc: '' }],
    ['a long toc', { toc: 'x'.repeat(5000) }, { toc: 'x'.repeat(200) }],
    ['fraction a string', { fraction: '0.5' }, { fraction: null }],
    ['fraction NaN', { fraction: NaN }, { fraction: null }],
    ['fraction past 1', { fraction: 1.5 }, { fraction: null }],
    ['fraction negative', { fraction: -0.1 }, { fraction: null }],
    ['index a float', { index: 1.5 }, { index: null }],
    ['index negative', { index: -1 }, { index: null }],
    ['sections huge', { sections: 1e9 }, { sections: null }],
    ['dir malformed', { dir: 'RTL' }, { dir: null }],
  ])('readRelocate_%s_Neutralised', (_, fields, want) => {
    const r = readRelocate({ type: 'relocate', fraction: 0.2, index: 1, sections: 2, toc: 't', ...fields })
    expect(r).toMatchObject(want)
  })

  it.each([['null', null], ['a string', 'relocate'], ['another type', { type: 'tap', fraction: 0.5 }]])('readRelocate_%s_Null', (_, m) => {
    expect(() => readRelocate(m)).not.toThrow()
    expect(readRelocate(m)).toBeNull()
  })
})

describe('v2 reader closing a book (Android host, #1264)', () => {
  /** Runs the close script against a page whose `flush()` posts a pending save, as saveScheduler does. */
  const run = (pending: boolean) => {
    const posted: string[] = []
    const window = {
      ReactNativeWebView: { postMessage: (m: string) => posted.push(m) },
      __fol: { flush: () => { if (pending) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'store', key: 'k', json: '{}' })) } },
    }
    new Function('window', CLOSE_BOOK_JS)(window)
    return posted.map((m) => JSON.parse(m).type)
  }

  it('closeScript_TheSaveLandsBeforeTheBookCloses', () => {
    expect(run(true)).toEqual(['store', BOOK_CLOSED])
  })

  it('closeScript_NothingPending_OnlyTheMarker', () => {
    expect(run(false)).toEqual([BOOK_CLOSED])
  })

  it('closeScript_PageWithoutFol_StillCloses', () => {
    const posted: string[] = []
    new Function('window', CLOSE_BOOK_JS)({ ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } })
    expect(posted).toEqual([JSON.stringify({ type: BOOK_CLOSED })])
  })

  it('closedBook_ReadyReopensNothing', () => {
    expect(reopensOnReady({ opening: { file: 'books/a.epub' }, inBook: true })).toBe(true)
    expect(reopensOnReady({ opening: { file: 'books/a.epub' }, inBook: false })).toBe(false)
    expect(reopensOnReady({ opening: null, inBook: true })).toBe(false)
  })

  it('noBook_TapKeyWordSelectionDropped_RestTaken', () => {
    for (const t of ['tap', 'key', 'word', 'selection']) expect(takenWithoutBook(t)).toBe(false)
    for (const t of ['ready', 'opened', 'store', 'relocate', BOOK_CLOSED]) expect(takenWithoutBook(t)).toBe(true)
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
