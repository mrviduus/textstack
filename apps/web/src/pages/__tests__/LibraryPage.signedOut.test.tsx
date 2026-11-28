import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  withoutSession: false,
  getUserBooks: vi.fn(),
  auth: { isAuthenticated: false, isLoading: false, user: null, openAuthModal: vi.fn() },
}))
vi.mock('../../platform', () => ({
  platform: { library: { get withoutSession() { return state.withoutSession }, getUserBooks: () => state.getUserBooks() } },
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => state.auth }))
vi.mock('../../components/SeoHead', () => ({ SeoHead: () => null }))
vi.mock('../../components/library/LibrarySidebar', () => ({ LibrarySidebar: () => null }))
vi.mock('../../components/library/UploadDropZone', () => ({ UploadDropZone: () => <p>add your first book</p> }))
vi.mock('../../components/library/UploadBookListItem', () => ({
  UploadBookListItem: ({ book }: { book: { title: string } }) => <p>{book.title}</p>,
}))

import { LibraryPage } from '../LibraryPage'

const book = { id: 'b1', title: 'A Book On The Device', author: null, tags: [], status: 'Ready', createdAt: '2026-11-01T00:00:00Z' }
const open = () => render(<MemoryRouter initialEntries={['/en/library']}><LibraryPage /></MemoryRouter>)

describe('the library with no session', () => {
  beforeEach(() => {
    state.withoutSession = false
    state.getUserBooks.mockReset().mockResolvedValue([book])
    state.auth.openAuthModal.mockReset()
  })

  it('asks a website visitor to sign in, and reads no books', () => {
    open()
    expect(screen.getByText('Sign in to save books to your library and track your reading progress.')).toBeInTheDocument()
    expect(state.getUserBooks).not.toHaveBeenCalled()
  })

  it('lists the books on the device in the Android app, and offers to sign in to keep them', async () => {
    state.withoutSession = true
    open()
    expect(await screen.findByText('A Book On The Device')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('these books are on this device')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(state.auth.openAuthModal).toHaveBeenCalledTimes(1)
  })

  it('offers a first book, with no sign-in banner, when the device has none', async () => {
    state.withoutSession = true
    state.getUserBooks.mockResolvedValue([])
    open()
    expect(await screen.findByText('add your first book')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
