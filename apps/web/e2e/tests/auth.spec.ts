import { test, expect } from '@playwright/test'

const API_URL = process.env.API_URL ?? 'http://localhost:8080'

test.describe('Auth', () => {
  test('test-login creates session', async ({ request, page }) => {
    // Call test-login API
    const resp = await request.post(`${API_URL}/auth/test-login`, {
      data: { email: 'e2e-auth-test@textstack.app' },
      headers: { Host: 'general.localhost' },
    })
    expect(resp.status()).toBe(200)

    const body = await resp.json()
    expect(body.user).toBeDefined()
    expect(body.user.email).toBe('e2e-auth-test@textstack.app')
  })

  test('auth/me returns user after login', async ({ request }) => {
    // Login
    await request.post(`${API_URL}/auth/test-login`, {
      data: { email: 'e2e-me-test@textstack.app' },
      headers: { Host: 'general.localhost' },
    })

    // Check /auth/me
    const meResp = await request.get(`${API_URL}/auth/me`, {
      headers: { Host: 'general.localhost' },
    })
    expect(meResp.status()).toBe(200)

    const me = await meResp.json()
    expect(me.user.email).toBe('e2e-me-test@textstack.app')
  })

  test('logout clears session', async ({ request }) => {
    // Login
    await request.post(`${API_URL}/auth/test-login`, {
      data: { email: 'e2e-logout-test@textstack.app' },
      headers: { Host: 'general.localhost' },
    })

    // Logout
    const logoutResp = await request.post(`${API_URL}/auth/logout`, {
      headers: { Host: 'general.localhost' },
    })
    expect(logoutResp.status()).toBe(200)

    // auth/me should now fail
    const meResp = await request.get(`${API_URL}/auth/me`, {
      headers: { Host: 'general.localhost' },
    })
    expect(meResp.status()).toBe(401)
  })

  test('refresh token rotation', async ({ request }) => {
    // Login
    await request.post(`${API_URL}/auth/test-login`, {
      data: { email: 'e2e-refresh-test@textstack.app' },
      headers: { Host: 'general.localhost' },
    })

    // Refresh
    const refreshResp = await request.post(`${API_URL}/auth/refresh`, {
      headers: { Host: 'general.localhost' },
    })
    expect(refreshResp.status()).toBe(200)

    // Still authenticated
    const meResp = await request.get(`${API_URL}/auth/me`, {
      headers: { Host: 'general.localhost' },
    })
    expect(meResp.status()).toBe(200)
  })
})
