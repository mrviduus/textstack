import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

import { CookieBanner } from '../CookieBanner'

const height = () => document.documentElement.style.getPropertyValue('--cookie-banner-height')

// #1292: what must sit above an unanswered banner (the V2 reader's bottom bar) reads its height from the root.
describe('CookieBanner', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(96)
  })
  afterEach(() => vi.restoreAllMocks())

  it('Render_Unanswered_PublishesItsHeight', () => {
    render(<MemoryRouter><CookieBanner /></MemoryRouter>)
    expect(height()).toBe('96px')
  })

  it.each(['Reject analytics', 'Accept all'])('Click_%s_RemovesTheHeight', (name) => {
    render(<MemoryRouter><CookieBanner /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name }))
    expect(height()).toBe('')
  })

  it('Render_AlreadyAnswered_PublishesNothing', () => {
    localStorage.setItem('cookieConsent', 'rejected')
    render(<MemoryRouter><CookieBanner /></MemoryRouter>)
    expect(height()).toBe('')
  })

  it('Unmount_Unanswered_RemovesTheHeight', () => {
    const { unmount } = render(<MemoryRouter><CookieBanner /></MemoryRouter>)
    unmount()
    expect(height()).toBe('')
  })
})
