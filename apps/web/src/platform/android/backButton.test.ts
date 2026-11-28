import { beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({ listener: null as null | ((e: { canGoBack: boolean }) => void), exitApp: vi.fn() }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (_: string, l: (e: { canGoBack: boolean }) => void) => { app.listener = l },
    exitApp: app.exitApp,
  },
}))

import { onBackButton, startBackButton } from './backButton'

const press = (canGoBack = true) => app.listener!({ canGoBack })

describe('the Android Back key', () => {
  beforeEach(async () => {
    app.exitApp.mockReset()
    startBackButton()
    await vi.waitFor(() => expect(app.listener).not.toBeNull())
  })

  it('goes one step back in the app when nothing is open on top', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    press()
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })

  it('leaves the app when there is no step back', () => {
    press(false)
    expect(app.exitApp).toHaveBeenCalledTimes(1)
  })

  it('closes what is on top first: the newest, then the one under it, then the page goes back', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const closed: string[] = []
    const offSheet = onBackButton(() => { closed.push('sheet'); offSheet() })
    const offMenu = onBackButton(() => { closed.push('menu'); offMenu() })
    press(); press(); press()
    expect(closed).toEqual(['menu', 'sheet'])
    expect(back).toHaveBeenCalledTimes(1)
    back.mockRestore()
  })
})
