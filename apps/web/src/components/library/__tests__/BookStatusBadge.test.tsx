import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { BookStatusBadge } from '../BookStatusBadge'

afterEach(() => cleanup())

describe('BookStatusBadge', () => {
  it('renders failed variant as button when onClick passed', () => {
    const onClick = vi.fn()
    render(<BookStatusBadge variant="failed" onClick={onClick} />)
    const btn = screen.getByRole('button', { name: 'library.badge.failed' })
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders new variant as non-interactive span', () => {
    render(<BookStatusBadge variant="new" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('library.badge.new')).toBeInTheDocument()
  })

  it('renders finished variant with checkmark', () => {
    const { container } = render(<BookStatusBadge variant="finished" />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByText('library.badge.finished')).toBeInTheDocument()
  })
})
