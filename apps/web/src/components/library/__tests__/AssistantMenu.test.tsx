import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const listOAuthGrants = vi.fn()
vi.mock('../../../api/oauth', () => ({ listOAuthGrants: () => listOAuthGrants() }))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

import { AssistantMenu } from '../AssistantMenu'
import { __resetAssistantGrants } from '../../../hooks/useAssistantLauncher'

const upload = { title: 'AI Engineering', author: 'Chip Huyen', bookId: 'b1', progressFraction: 0.42, chapterTitle: '5. Prompt Engineering' }
const current = { slug: 'prompts', title: '5. Prompt Engineering', reviewed: false }
const open = vi.fn()

function renderMenu(props: Partial<Parameters<typeof AssistantMenu>[0]> = {}) {
  return render(<MemoryRouter><AssistantMenu book={upload} current={current} {...props} /></MemoryRouter>)
}

/** Open the menu and let the grants prefetch land, so item clicks take the synchronous path. */
async function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Assistant/ }))
  await waitFor(() => expect(listOAuthGrants).toHaveBeenCalled())
  await Promise.resolve()
}

const item = (name: RegExp) => screen.getByRole('menuitem', { name })

beforeEach(() => {
  __resetAssistantGrants()
  listOAuthGrants.mockReset()
  open.mockReset()
  vi.stubGlobal('open', open)
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AssistantMenu', () => {
  it('does not fetch grants until opened (the page is prerendered / seen signed out)', () => {
    renderMenu()
    expect(listOAuthGrants).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('current chapter → ONE discuss item, naming the chapter; no book item', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderMenu()
    await openMenu()
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(item(/Discuss current chapter/)).toHaveTextContent('5. Prompt Engineering')
    expect(screen.queryByRole('menuitem', { name: /Discuss the book/ })).toBeNull()
  })

  it('no current chapter → only "Discuss the book"', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderMenu({ current: null })
    await openMenu()
    expect(screen.getAllByRole('menuitem')).toHaveLength(1)
    expect(item(/Discuss the book/)).toBeInTheDocument()
  })

  it('current chapter already reviewed → "Open review" link + discuss the chapter again', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderMenu({ current: { ...current, reviewed: true } })
    await openMenu()
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    expect(item(/Open review of current chapter/)).toHaveAttribute('href', '/en/library/my/b1/review/prompts')
    expect(item(/Discuss current chapter/)).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Discuss the book/ })).toBeNull()
  })

  it('catalog book: the review link uses the slug', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderMenu({ book: { title: 'Dracula', editionId: 'e1', slug: 'dracula' }, current: { ...current, reviewed: true } })
    await openMenu()
    expect(item(/Open review/)).toHaveAttribute('href', '/en/books/dracula/review/prompts')
  })

  it('old "Open in Claude / ChatGPT" links and the connector hint are gone', async () => {
    listOAuthGrants.mockResolvedValue([])
    renderMenu()
    await openMenu()
    expect(screen.queryByText(/Open in Claude|Open in ChatGPT|connector/)).toBeNull()
  })

  for (const [which, cur] of [['Discuss the book', null], ['Discuss current chapter', current]] as const) {
    describe(which, () => {
      it('0 grants → connect dialog, nothing opened', async () => {
        listOAuthGrants.mockResolvedValue([])
        renderMenu({ current: cur })
        await openMenu()
        fireEvent.click(item(new RegExp(which)))
        expect(await screen.findByRole('dialog')).toHaveTextContent('Connect Claude or ChatGPT in a minute')
        expect(open).not.toHaveBeenCalled()
      })

      it('1 grant → opens it', async () => {
        listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
        renderMenu({ current: cur })
        await openMenu()
        fireEvent.click(item(new RegExp(which)))
        expect(open).toHaveBeenCalledTimes(1)
        expect((open.mock.calls[0][0] as string).startsWith('https://claude.ai/new?q=')).toBe(true)
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      })

      it('2 grants, nothing remembered → pick, remembered, opened', async () => {
        listOAuthGrants.mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
        renderMenu({ current: cur })
        await openMenu()
        fireEvent.click(item(new RegExp(which)))
        expect(open).not.toHaveBeenCalled()
        fireEvent.click(item(/^ChatGPT$/))
        expect(localStorage.getItem('chapterReview.assistant')).toBe('chatgpt')
        expect((open.mock.calls[0][0] as string).startsWith('https://chatgpt.com/?q=')).toBe(true)
      })
    })
  }

  it('the briefs: book discuss is the humanized handoff, chapter discuss names the chapter', async () => {
    listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
    const { unmount } = renderMenu({ current: null })
    await openMenu()
    fireEvent.click(item(/Discuss the book/))
    const discuss = decodeURIComponent(open.mock.calls[0][0] as string)
    expect(discuss).toContain('Let\'s discuss "AI Engineering" by Chip Huyen in TextStack. I\'m about 42% in, at "5. Prompt Engineering".')
    expect(discuss).toContain('(TextStack: book b1)')
    expect((open.mock.calls[0][0] as string).length).toBeLessThanOrEqual(2000)

    unmount()
    renderMenu()
    await openMenu()
    fireEvent.click(item(/Discuss current chapter/))
    const chapter = decodeURIComponent(open.mock.calls[1][0] as string)
    expect(chapter).toContain('at the chapter "5. Prompt Engineering". Let\'s talk about it.')
    expect(chapter).toContain('(TextStack: book b1, chapter prompts)')
  })

  it('catalog chapter brief carries slug + edition id', async () => {
    listOAuthGrants.mockResolvedValue([{ id: 'g', clientName: 'Claude' }])
    renderMenu({ book: { title: 'Dracula', editionId: 'e1', slug: 'dracula' } })
    await openMenu()
    fireEvent.click(item(/Discuss current chapter/))
    expect(decodeURIComponent(open.mock.calls[0][0] as string)).toContain('catalog dracula, edition e1')
  })

  it('both connected: the "Chat in" toggle switches the remembered chat', async () => {
    localStorage.setItem('chapterReview.assistant', 'claude')
    listOAuthGrants.mockResolvedValue([{ id: '1', clientName: 'Claude' }, { id: '2', clientName: 'ChatGPT' }])
    renderMenu()
    await openMenu()
    const group = await screen.findByRole('group', { name: 'Chat in' })
    expect(group.querySelector('[aria-pressed="true"]')).toHaveTextContent('Claude')
    fireEvent.click(screen.getByRole('button', { name: 'ChatGPT', pressed: false }))
    expect(localStorage.getItem('chapterReview.assistant')).toBe('chatgpt')
    fireEvent.click(item(/Discuss/))
    expect((open.mock.calls[0][0] as string).startsWith('https://chatgpt.com/')).toBe(true)
  })
})
