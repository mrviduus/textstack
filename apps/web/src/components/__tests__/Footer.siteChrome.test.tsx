import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The website has the site chrome; the Android app (ADR-035) does not.
const platform = vi.hoisted(() => ({ siteChrome: true }))
vi.mock('../../platform', () => ({ platform }))
vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

import { Footer } from '../Footer'
import { PLAY_URL } from '../AndroidAppBanner'

describe('Footer and the site chrome', () => {
  it('Web_ShowsThePlayLinks', () => {
    platform.siteChrome = true
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(container.querySelectorAll(`a[href="${PLAY_URL}"]`)).toHaveLength(2)
  })

  it('NoSiteChrome_KeepsTheLegalAndAccountLinks_DropsThePlayLinks', () => {
    platform.siteChrome = false
    const { container } = render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(container.querySelector('a[href="/en/privacy"]')).not.toBeNull()
    expect(container.querySelector('a[href="/en/delete-account"]')).not.toBeNull()
    expect(container.querySelector(`a[href="${PLAY_URL}"]`)).toBeNull()
    expect(screen.queryByRole('contentinfo')).not.toBeNull()
  })
})
