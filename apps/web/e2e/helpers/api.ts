import type { APIRequestContext } from '@playwright/test'

const API_URL = process.env.API_URL ?? 'http://localhost:8080'

export async function testLogin(request: APIRequestContext, email = 'e2e-test@textstack.app') {
  const resp = await request.post(`${API_URL}/auth/test-login`, {
    data: { email },
    headers: { Host: 'general.localhost' },
  })
  if (!resp.ok()) throw new Error(`test-login failed: ${resp.status()} ${await resp.text()}`)
  return resp
}

export async function adminLogin(request: APIRequestContext) {
  const resp = await request.post(`${API_URL}/admin/auth/login`, {
    data: {
      email: process.env.ADMIN_EMAIL ?? 'admin@textstack.app',
      password: process.env.ADMIN_PASSWORD ?? 'admin',
    },
    headers: { Host: 'general.localhost' },
  })
  if (!resp.ok()) throw new Error(`admin login failed: ${resp.status()} ${await resp.text()}`)
  return resp
}

export async function uploadBook(
  request: APIRequestContext,
  opts: {
    filePath: string
    title: string
    language: string
    siteId: string
    authorIds: string
    genreId: string
    description?: string
  }
) {
  const resp = await request.post(`${API_URL}/admin/books/upload`, {
    headers: { Host: 'general.localhost' },
    multipart: {
      file: { name: opts.filePath.split('/').pop()!, mimeType: 'application/epub+zip', buffer: (await import('fs')).readFileSync(opts.filePath) },
      siteId: opts.siteId,
      title: opts.title,
      language: opts.language,
      description: opts.description ?? '',
      authorIds: opts.authorIds,
      genreId: opts.genreId,
    },
  })
  if (!resp.ok()) throw new Error(`upload failed: ${resp.status()} ${await resp.text()}`)
  return resp.json()
}

export async function waitForIngestion(request: APIRequestContext, jobId: string, timeoutMs = 60_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const resp = await request.get(`${API_URL}/admin/ingestion/jobs/${jobId}`, {
      headers: { Host: 'general.localhost' },
    })
    if (resp.ok()) {
      const job = await resp.json()
      if (job.status === 'Completed') return job
      if (job.status === 'Failed') throw new Error(`Ingestion failed: ${JSON.stringify(job)}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`Ingestion timeout after ${timeoutMs}ms`)
}

export async function getEdition(request: APIRequestContext, editionId: string) {
  const resp = await request.get(`${API_URL}/books/editions/${editionId}`, {
    headers: { Host: 'general.localhost' },
  })
  if (!resp.ok()) throw new Error(`getEdition failed: ${resp.status()}`)
  return resp.json()
}

export async function getSiteInfo(request: APIRequestContext) {
  const resp = await request.get(`${API_URL}/site`, {
    headers: { Host: 'general.localhost' },
  })
  if (!resp.ok()) throw new Error(`getSite failed: ${resp.status()}`)
  return resp.json()
}
