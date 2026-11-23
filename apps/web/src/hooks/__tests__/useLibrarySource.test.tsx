import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useLibrarySource } from '../useLibrarySource'

const wrapper = (initial = '/library') => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
)

describe('useLibrarySource', () => {
  it('defaults to all when no params', () => {
    const { result } = renderHook(() => useLibrarySource(), { wrapper: wrapper() })
    expect(result.current.source).toBe('all')
    expect(result.current.tag).toBeNull()
  })

  it('reads source from URL', () => {
    const { result } = renderHook(() => useLibrarySource(), {
      wrapper: wrapper('/library?source=uploads'),
    })
    expect(result.current.source).toBe('uploads')
  })

  it('falls back to all for unknown source value', () => {
    const { result } = renderHook(() => useLibrarySource(), {
      wrapper: wrapper('/library?source=garbage'),
    })
    expect(result.current.source).toBe('all')
  })

  it('reads tag from URL', () => {
    const { result } = renderHook(() => useLibrarySource(), {
      wrapper: wrapper('/library?tag=fantasy'),
    })
    expect(result.current.tag).toBe('fantasy')
  })

  it('setSource clears tag', () => {
    let location: { search: string } = { search: '' }
    const Capture = () => { location = useLocation(); return null }
    const w = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/library?tag=foo']}>
        <Capture />
        {children}
      </MemoryRouter>
    )
    const { result } = renderHook(() => useLibrarySource(), { wrapper: w })
    act(() => result.current.setSource('uploads'))
    expect(location.search).toBe('?source=uploads')
  })

  it('setSource(all) deletes source param', () => {
    let location: { search: string } = { search: '' }
    const Capture = () => { location = useLocation(); return null }
    const w = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/library?source=uploads']}>
        <Capture />
        {children}
      </MemoryRouter>
    )
    const { result } = renderHook(() => useLibrarySource(), { wrapper: w })
    act(() => result.current.setSource('all'))
    expect(location.search).toBe('')
  })

  it('setTag keeps source', () => {
    let location: { search: string } = { search: '' }
    const Capture = () => { location = useLocation(); return null }
    const w = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/library?source=uploads']}>
        <Capture />
        {children}
      </MemoryRouter>
    )
    const { result } = renderHook(() => useLibrarySource(), { wrapper: w })
    act(() => result.current.setTag('fantasy'))
    expect(location.search).toContain('source=uploads')
    expect(location.search).toContain('tag=fantasy')
  })
})
