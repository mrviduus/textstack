import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

import { Footer } from '../Footer'

describe('Footer', () => {
  const scrollTo = vi.fn()
  beforeEach(() => {
    scrollTo.mockClear()
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
    render(<MemoryRouter><Footer /></MemoryRouter>)
  })

  // #1245: the new page opened on its own footer.
  it('Click_InAppLink_ScrollsToTop', () => {
    fireEvent.click(screen.getByRole('link', { name: 'About' }))
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('Click_NewTabLink_LeavesScrollAlone', () => {
    fireEvent.click(screen.getByRole('link', { name: /Developers/ }))
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
