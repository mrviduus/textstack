import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AndroidAppBanner } from '../AndroidAppBanner'

vi.mock('../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 7 Pro) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36'
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36'

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AndroidAppBanner />
    </MemoryRouter>,
  )
}

const shown = () => screen.queryByText('androidApp.title') !== null

describe('AndroidAppBanner', () => {
  beforeEach(() => {
    localStorage.clear()
    setUserAgent(ANDROID)
    // The two preconditions a returning Android reader would already have.
    localStorage.setItem('cookieConsent', 'accepted')
    localStorage.setItem('androidTesterBanner.hasRead', '1')
  })

  it('shows for an Android reader who has read and answered the cookie banner', () => {
    renderAt('/en')
    expect(shown()).toBe(true)
  })

  it('stays hidden on desktop', () => {
    setUserAgent(DESKTOP)
    renderAt('/en')
    expect(shown()).toBe(false)
  })

  it('stays hidden until the cookie banner has been answered', () => {
    localStorage.removeItem('cookieConsent')
    renderAt('/en')
    expect(shown()).toBe(false)
  })

  it('stays hidden for someone who has not opened a book', () => {
    localStorage.removeItem('androidTesterBanner.hasRead')
    renderAt('/en')
    expect(shown()).toBe(false)
  })

  it('stays hidden once dismissed', () => {
    localStorage.setItem('androidTesterBanner', 'dismissed')
    renderAt('/en')
    expect(shown()).toBe(false)
  })

  // Production 301s chapter URLs to a trailing slash. A pattern anchored on the bare
  // segment matches under `vite preview` and never matches on the live site.
  it.each([
    '/en/books/twelfth-night/2-act-i',
    '/en/books/twelfth-night/2-act-i/',
    '/en/library/my/abc/read',
    '/en/library/my/abc/read/ch-1/',
  ])('never interrupts the reader at %s', (path) => {
    renderAt(path)
    expect(shown()).toBe(false)
  })

  it.each(['/en/books/twelfth-night', '/en/books/twelfth-night/'])(
    'still shows on the book page %s, which is not the reader',
    (path) => {
      renderAt(path)
      expect(shown()).toBe(true)
    },
  )

  it('records the read flag when the reader is visited', () => {
    localStorage.removeItem('androidTesterBanner.hasRead')
    renderAt('/en/books/twelfth-night/2-act-i/')
    expect(localStorage.getItem('androidTesterBanner.hasRead')).toBe('1')
  })
})
