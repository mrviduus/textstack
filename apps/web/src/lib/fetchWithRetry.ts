export interface FetchOptions {
  timeout?: number
  retries?: number
  backoff?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT = 10000
const DEFAULT_RETRIES = 3
const DEFAULT_BACKOFF = 1000

export class FetchTimeoutError extends Error {
  constructor() {
    super('Request timed out')
    this.name = 'FetchTimeoutError'
  }
}

export class FetchRetryExhaustedError extends Error {
  constructor(public lastError: Error) {
    super(`All retries exhausted: ${lastError.message}`)
    this.name = 'FetchRetryExhaustedError'
  }
}

export class InvalidContentTypeError extends Error {
  constructor(received: string) {
    super(`Expected JSON but received ${received || 'unknown'} (likely 404 page)`)
    this.name = 'InvalidContentTypeError'
  }
}

async function fetchWithTimeout(
  url: string,
  timeout: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  // Link external signal if provided
  const abortHandler = () => controller.abort()
  externalSignal?.addEventListener('abort', abortHandler)

  try {
    const res = await fetch(url, { signal: controller.signal })
    return res
  } catch (err) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new FetchTimeoutError()
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortHandler)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithRetry(
  url: string,
  options?: FetchOptions
): Promise<Response> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT
  const retries = options?.retries ?? DEFAULT_RETRIES
  const backoff = options?.backoff ?? DEFAULT_BACKOFF
  const signal = options?.signal

  let lastError: Error = new Error('Unknown error')

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Check if externally aborted
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    try {
      const res = await fetchWithTimeout(url, timeout, signal)
      return res
    } catch (err) {
      lastError = err as Error

      // Don't retry if externally aborted
      if (signal?.aborted) {
        throw err
      }

      // Don't retry non-retryable errors
      if (err instanceof TypeError) {
        // Network error - retryable
      } else if (err instanceof FetchTimeoutError) {
        // Timeout - retryable
      } else {
        throw err
      }

      // Wait before next retry (exponential backoff)
      if (attempt < retries) {
        const delay = backoff * Math.pow(2, attempt)
        await sleep(delay)
      }
    }
  }

  throw new FetchRetryExhaustedError(lastError)
}

export async function fetchJsonWithRetry<T>(
  url: string,
  options?: FetchOptions
): Promise<T> {
  const res = await fetchWithRetry(url, options)
  if (!res.ok) throw new Error(`API error: ${res.status}`)

  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new InvalidContentTypeError(contentType)
  }

  return res.json()
}
