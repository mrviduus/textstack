import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const back = vi.hoisted(() => ({ handlers: [] as (() => void)[] }))
vi.mock('../platform', () => ({
  platform: {
    onBackButton: (h: () => void) => {
      back.handlers.push(h)
      return () => { back.handlers.splice(back.handlers.indexOf(h), 1) }
    },
  },
}))

import { Sheet } from './Sheet'

const onClose = vi.fn()
const open = () => render(<Sheet open onClose={onClose} title="Add a book"><button>Pick a file</button></Sheet>)
const handle = () => document.querySelector('.sheet__handle')!
const drag = (to: number) => {
  fireEvent.pointerDown(handle(), { clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(handle(), { clientY: 100 + to, pointerId: 1 })
  fireEvent.pointerUp(handle(), { pointerId: 1 })
}

describe('a sheet', () => {
  beforeEach(() => { onClose.mockReset(); back.handlers.length = 0 })

  it('is a named dialog that holds the focus', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Add a book' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
  })

  it('renders nothing while it is closed', () => {
    render(<Sheet open={false} onClose={onClose} title="Add a book">x</Sheet>)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(back.handlers).toHaveLength(0)
  })

  it('closes on Escape, a tap outside and the close button, and not on a tap inside', () => {
    open()
    fireEvent.click(screen.getByText('Pick a file'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('.sheet__overlay')!)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('closes on the Android Back key while it is open, and gives the key back after', () => {
    const { unmount } = open()
    expect(back.handlers).toHaveLength(1)
    back.handlers[0]()
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(back.handlers).toHaveLength(0)
  })

  it('closes when its handle is dragged far down, and springs back from a short drag', () => {
    open()
    drag(40)
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByRole('dialog') as HTMLElement).style.transform).toBe('')
    drag(120)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stops the page behind it from scrolling, until it closes', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = open()
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
  })
})
