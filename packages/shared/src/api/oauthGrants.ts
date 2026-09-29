import { authFetch } from './client'
import type { OAuthGrant } from '../lib/mcpConnect'

/**
 * "Connected apps" over the shared client — the mobile path. The web has its own copy in
 * `apps/web/src/api/oauth.ts` for the same cookie-vs-bearer reason as `./mcpKeys`.
 */

export async function listOAuthGrants(): Promise<OAuthGrant[]> {
  const res = await authFetch<{ items: OAuthGrant[] }>('/me/oauth/grants')
  return res.items
}

export async function revokeOAuthGrant(id: string): Promise<void> {
  await authFetch<void>(`/me/oauth/grants/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
