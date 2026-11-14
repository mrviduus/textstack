import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useFocusTrap } from './useFocusTrap'

function Dialog() {
  const ref = useFocusTrap(true)
  return (
    <div ref={ref} role="dialog">
      <button>first</button>
      <button>last enabled</button>
      <fieldset disabled><button>in a disabled fieldset</button></fieldset>
      <button disabled>disabled</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  // #1260 review: a fixed-layout book's settings panel ends in a disabled fieldset; Tab must wrap, not leave.
  it('tabOnTheLastEnabledControl_WrapsToTheFirst_DisabledOnesSkipped', () => {
    const { getByText } = render(<Dialog />)
    expect(document.activeElement).toBe(getByText('first'))
    getByText('last enabled').focus()
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(false) // prevented: the trap moved focus
    expect(document.activeElement).toBe(getByText('first'))
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(document.activeElement).toBe(getByText('last enabled'))
  })
})
