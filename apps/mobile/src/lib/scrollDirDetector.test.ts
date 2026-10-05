import { describe, it, expect, beforeEach } from 'vitest'
import { SCROLL_DIR_DETECTOR, READER_SELECTION_BRIDGE } from './readerBridge'

type FakeWindow = {
  scrollY: number
  addEventListener: (type: string, fn: () => void) => void
  ReactNativeWebView: { postMessage: (m: string) => void }
  __tsSetBars?: (visible: boolean) => void
}

let win: FakeWindow
let onScroll: () => void
let posted: string[]

function scrollTo(y: number) {
  win.scrollY = y
  onScroll()
}
/** Scroll by `total` px in `step` px events (slow finger / trackpad). */
function scrollBy(total: number, step = 10) {
  const dir = Math.sign(total)
  for (let moved = 0; moved < Math.abs(total); moved += step) scrollTo(win.scrollY + dir * step)
}

beforeEach(() => {
  posted = []
  win = {
    scrollY: 1000,
    addEventListener: (type, fn) => { if (type === 'scroll') onScroll = fn },
    ReactNativeWebView: { postMessage: (m) => posted.push(JSON.parse(m).dir) },
  }
  new Function('window', SCROLL_DIR_DETECTOR)(win)
})

describe('SCROLL_DIR_DETECTOR', () => {
  it('is embedded in the reader bridge', () => {
    expect(READER_SELECTION_BRIDGE).toContain(SCROLL_DIR_DETECTOR)
  })

  it('down ≥48px hides, 6px up reveals', () => {
    scrollBy(50)
    expect(posted).toEqual(['down'])
    scrollBy(-6, 6)
    expect(posted).toEqual(['down', 'up'])
  })

  it('slow scroll down after a reveal hides again at 48px', () => {
    scrollBy(50)
    scrollBy(-20)
    expect(posted).toEqual(['down', 'up'])
    scrollBy(40)
    expect(posted).toEqual(['down', 'up'])
    scrollBy(10)
    expect(posted).toEqual(['down', 'up', 'down'])
  })

  it('20px down wobble while visible does not hide', () => {
    scrollBy(-10)
    scrollBy(20)
    expect(posted).toEqual(['up'])
  })

  it('__tsSetBars(true) after a down-run: scrolling down 48px posts down', () => {
    scrollBy(50)
    expect(posted).toEqual(['down'])
    win.__tsSetBars!(true) // RN tap showed bars
    scrollBy(50)
    expect(posted).toEqual(['down', 'down'])
  })

  it('__tsSetBars(false) while visible: scrolling up posts up', () => {
    scrollBy(-10)
    expect(posted).toEqual(['up'])
    win.__tsSetBars!(false) // RN tap / initial timer hid bars
    scrollBy(-2, 2)
    expect(posted).toEqual(['up', 'up'])
  })
})
