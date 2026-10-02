import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The hero picks its Continue card from /me/library/shelves alone — not from
// /me/library + /me/progress + /me/books (3 requests → 1).
const authFetch = vi.fn(async () => ({}))
const getLibraryShelves = vi.fn()
const authState = { isAuthenticated: true }

vi.mock('../../../api/client', async (orig) => ({
  ...(await orig<typeof import('../../../api/client')>()),
  authFetch: () => authFetch(),
}))
vi.mock('@textstack/shared', async (orig) => ({
  ...(await orig<typeof import('@textstack/shared')>()),
  libraryApi: { getLibraryShelves: () => getLibraryShelves() },
}))
vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ ...authState, ensureSession: vi.fn() }),
}))
vi.mock('../../../context/GuestLimitsContext', () => ({
  useGuestLimits: () => ({ isReturningUser: false, guestState: { currentBook: null } }),
}))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))
vi.mock('../../../context/NativeLanguageContext', () => ({
  useNativeLanguage: () => ({ nativeLanguage: 'uk', setNativeLanguage: vi.fn(), hasConfirmedLanguage: true }),
}))
vi.mock('../../Search', () => ({ MobileSearchOverlay: () => null }))
vi.mock('../../LocalizedLink', () => ({
  LocalizedLink: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) =>
    <a href={`/en${to}`} className={className}>{children}</a>,
}))

import { HeroSection } from '../HeroSection'
import { clearLibraryShelvesCache } from '../../../hooks/useLibraryShelves'

const item = (over: Record<string, unknown>) => ({
  id: 'u1', type: 'userbook', title: 'Clip', author: null, coverPath: null, slug: 'clip',
  language: 'en', progressPercent: 0.4, lastOpenedAt: null, createdAt: '',
  estimatedMinutesRemaining: null, chapterSlug: 'ch-2', ...over,
})
const shelves = (continueReading: unknown[]) =>
  ({ continueReading, recentlyAdded: [], quickReads: [], finishedThisMonth: [] })

const renderHero = () => render(<MemoryRouter><HeroSection /></MemoryRouter>)

beforeEach(() => {
  authFetch.mockClear()
  getLibraryShelves.mockReset()
  clearLibraryShelvesCache()
  authState.isAuthenticated = true
})
afterEach(() => cleanup())

describe('HeroSection continue card', () => {
  it('one shelves request, no list fetches; links to the saved chapter', async () => {
    getLibraryShelves.mockResolvedValue(shelves([item({}), item({ id: 'u2', title: 'Older' })]))
    renderHero()
    const title = await screen.findByText('Clip')
    expect(title.closest('a')?.getAttribute('href')).toBe('/en/library/my/u1/read/ch-2')
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.queryByText('Older')).toBeNull()
    expect(getLibraryShelves).toHaveBeenCalledTimes(1)
    expect(authFetch).not.toHaveBeenCalled()
  })

  it('saved catalog book links to its chapter; chapterless falls back to the book', async () => {
    getLibraryShelves.mockResolvedValue(shelves([
      item({ type: 'savedbook', slug: 'dracula', chapterSlug: 'ch-3' }),
    ]))
    renderHero()
    expect((await screen.findByText('Clip')).closest('a')?.getAttribute('href')).toBe('/en/books/dracula/ch-3')
    cleanup()
    clearLibraryShelvesCache()
    getLibraryShelves.mockResolvedValue(shelves([item({ chapterSlug: null })]))
    renderHero()
    expect((await screen.findByText('Clip')).closest('a')?.getAttribute('href')).toBe('/en/library/my/u1/read')
  })

  it('empty shelf → no card', async () => {
    getLibraryShelves.mockResolvedValue(shelves([]))
    renderHero()
    await waitFor(() => expect(getLibraryShelves).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.continue-reading__card')).toBeNull()
  })

  it('signed out → no request, no card', () => {
    authState.isAuthenticated = false
    renderHero()
    expect(getLibraryShelves).not.toHaveBeenCalled()
    expect(authFetch).not.toHaveBeenCalled()
    expect(document.querySelector('.continue-reading__card')).toBeNull()
  })
})
