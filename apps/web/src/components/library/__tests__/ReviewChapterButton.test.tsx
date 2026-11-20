import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const listOAuthGrants = vi.fn()
vi.mock('../../../api/oauth', () => ({ listOAuthGrants: () => listOAuthGrants() }))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

let isGuest = false
vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ isGuest }) }))

import { ReviewChapterButton, __resetReviewGrants } from '../ReviewChapterButton'

const props = { title: 'AI Engineering', bookId: 'b1', chapterSlug: 'prompts', chapterTitle: 'Prompt Engineering' }
const open = vi.fn()

function renderButton() {
  return render(<MemoryRouter><ReviewChapterButton {...props} /></MemoryRouter>)
}

beforeEach(() => {
  __resetReviewGrants()
  isGuest = false
  listOAuthGrants.mockReset()
  open.mockReset()
  vi.stubGlobal('open', open)
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function clickReview() {
  // Let the mount prefetch land so the click takes the synchronous (popup-safe) path.
  await waitFor(() => expect(listOAuthGrants).toHaveBeenCalled())
  await Promise.resolve()
  fireEvent.click(screen.getByRole('button', { name: /Discuss/ }))
}

describe('ReviewChapterButton', () => {
  it('nothing connected → opens ChatGPT with the chapter brief', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderButton()
    await clickReview()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/chatgpt\.com\/\?q=/)
  })

  it('a guest opens ChatGPT without asking for account-only grants', async () => {
    isGuest = true
    renderButton()
    fireEvent.click(screen.getByRole('button', { name: /Discuss/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(listOAuthGrants).not.toHaveBeenCalled()
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/chatgpt\.com\/\?q=/)
  })

  it('a failed grants call still opens ChatGPT', async () => {
    listOAuthGrants.mockRejectedValue(new Error('403'))
    renderButton()
    await clickReview()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/chatgpt\.com\/\?q=/)
  })

  it('one connected → opens it directly with the brief', async () => {
    listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'ChatGPT' }])
    renderButton()
    await clickReview()
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const url = open.mock.calls[0][0] as string
    expect(url.startsWith('https://chatgpt.com/?q=')).toBe(true)
    expect(decodeURIComponent(url)).toContain('at the chapter "Prompt Engineering". Let\'s talk about it.')
    expect(decodeURIComponent(url)).toContain('(TextStack: book b1, chapter prompts)')
  })

  it('both connected → menu; the pick is remembered and opened', async () => {
    listOAuthGrants.mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
    renderButton()
    await clickReview()
    fireEvent.click(await screen.findByRole('menuitem', { name: /Claude/ }))
    expect(localStorage.getItem('chapterReview.assistant')).toBe('claude')
    expect((open.mock.calls[0][0] as string).startsWith('https://claude.ai/new?q=')).toBe(true)
  })

  it('both connected + remembered → opens the remembered one without a menu', async () => {
    localStorage.setItem('chapterReview.assistant', 'chatgpt')
    listOAuthGrants.mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
    renderButton()
    await clickReview()
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('menu')).toBeNull()
    expect((open.mock.calls[0][0] as string).startsWith('https://chatgpt.com/')).toBe(true)
  })

  it('shows the ▾ switch only when both assistants are connected', async () => {
    listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
    renderButton()
    await clickReview()
    expect(screen.queryByRole('button', { name: 'Choose Claude or ChatGPT' })).toBeNull()
  })

  it('▾ with both connected: picking the other switches, opens it and is remembered', async () => {
    localStorage.setItem('chapterReview.assistant', 'claude')
    listOAuthGrants.mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
    renderButton()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose Claude or ChatGPT' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /ChatGPT/ }))
    expect(localStorage.getItem('chapterReview.assistant')).toBe('chatgpt')
    expect((open.mock.calls[0][0] as string).startsWith('https://chatgpt.com/')).toBe(true)

    // The main button now goes straight to the new choice.
    fireEvent.click(screen.getByRole('button', { name: /Discuss “/ }))
    expect(open).toHaveBeenCalledTimes(2)
    expect((open.mock.calls[1][0] as string).startsWith('https://chatgpt.com/')).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
