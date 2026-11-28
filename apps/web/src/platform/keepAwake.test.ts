import { afterEach, expect, it, vi } from 'vitest'
import { keepAwake } from './keepAwake'

afterEach(() => vi.unstubAllGlobals())

it('holds a screen lock until it is turned off, and takes it again when the page shows', async () => {
  const release = vi.fn(async () => {})
  // As the browser does: a hidden page's lock is released.
  const request = vi.fn(async () => ({ release, released: true }))
  vi.stubGlobal('navigator', { wakeLock: { request } })
  const off = keepAwake()
  await Promise.resolve()
  expect(request).toHaveBeenCalledWith('screen')
  document.dispatchEvent(new Event('visibilitychange'))
  expect(request).toHaveBeenCalledTimes(2)
  await Promise.resolve()
  off()
  expect(release).toHaveBeenCalled()
  document.dispatchEvent(new Event('visibilitychange'))
  expect(request).toHaveBeenCalledTimes(2)
})

it('does nothing where the browser has no screen lock', () => {
  vi.stubGlobal('navigator', {})
  expect(() => keepAwake()()).not.toThrow()
})
