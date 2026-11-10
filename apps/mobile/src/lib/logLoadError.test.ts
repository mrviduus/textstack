import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError } from '@textstack/shared'
import { logLoadError } from './logLoadError'

describe('logLoadError', () => {
  afterEach(() => vi.restoreAllMocks())

  it('warns when the server could not be reached', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offline = new ApiError(0, 'fetch failed')
    offline.isNetworkError = true
    logLoadError('Load failed:', offline)
    expect(warn).toHaveBeenCalledWith('Load failed:', offline)
    expect(error).not.toHaveBeenCalled()
  })

  it('errors when the server answered with a failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const serverError = new ApiError(500, 'Internal Server Error')
    logLoadError('Load failed:', serverError)
    expect(error).toHaveBeenCalledWith('Load failed:', serverError)
    expect(warn).not.toHaveBeenCalled()
  })
})
