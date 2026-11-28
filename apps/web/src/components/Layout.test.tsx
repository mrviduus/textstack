import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ appShell: false, isAuthenticated: false }))
vi.mock('../platform', () => ({ platform: { get appShell() { return state.appShell } } }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: state.isAuthenticated }) }))
vi.mock('./Header', () => ({ Header: () => <header>header</header> }))
vi.mock('./Footer', () => ({ Footer: () => <footer>footer</footer> }))
vi.mock('./TabBar', () => ({ TabBar: () => <nav>tabs</nav> }))
vi.mock('./library/GlobalDropZone', () => ({ GlobalDropZone: () => null }))

import { Layout } from './Layout'

const page = () => render(
  <MemoryRouter initialEntries={['/library']}>
    <Routes>
      <Route element={<Layout />}>
        <Route path="library" element={<p>the library</p>} />
      </Route>
    </Routes>
  </MemoryRouter>,
)

describe('the frame around a page', () => {
  beforeEach(() => { state.appShell = false; state.isAuthenticated = false })

  it('gives a website guest the header and the footer, and no tab bar', () => {
    page()
    expect(screen.getByText('the library')).toBeInTheDocument()
    expect(screen.getByText('header')).toBeInTheDocument()
    expect(screen.getAllByText('footer')).toHaveLength(1)
    expect(screen.queryByText('tabs')).toBeNull()
  })

  it('gives a reader with a session the tab bar', () => {
    state.isAuthenticated = true
    page()
    expect(screen.getByText('tabs')).toBeInTheDocument()
    expect(screen.getByText('footer')).toBeInTheDocument()
  })

  it('gives the Android app the tab bar without a session, and no site footer', () => {
    state.appShell = true
    page()
    expect(screen.getByText('tabs')).toBeInTheDocument()
    expect(screen.queryByText('footer')).toBeNull()
  })
})
