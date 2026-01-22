import { describe, it, expect } from 'vitest'
import {
  FetchTimeoutError,
  FetchRetryExhaustedError,
  InvalidContentTypeError,
} from './fetchWithRetry'

describe('FetchTimeoutError', () => {
  it('has correct name and message', () => {
    const error = new FetchTimeoutError()
    expect(error.name).toBe('FetchTimeoutError')
    expect(error.message).toBe('Request timed out')
    expect(error instanceof Error).toBe(true)
  })
})

describe('FetchRetryExhaustedError', () => {
  it('wraps the last error', () => {
    const lastError = new Error('Network failed')
    const error = new FetchRetryExhaustedError(lastError)

    expect(error.name).toBe('FetchRetryExhaustedError')
    expect(error.message).toBe('All retries exhausted: Network failed')
    expect(error.lastError).toBe(lastError)
    expect(error instanceof Error).toBe(true)
  })
})

describe('InvalidContentTypeError', () => {
  it('includes content type in message', () => {
    const error = new InvalidContentTypeError('text/html')
    expect(error.name).toBe('InvalidContentTypeError')
    expect(error.message).toBe('Expected JSON but received text/html (likely 404 page)')
    expect(error instanceof Error).toBe(true)
  })

  it('handles empty content type', () => {
    const error = new InvalidContentTypeError('')
    expect(error.message).toBe('Expected JSON but received unknown (likely 404 page)')
  })
})
