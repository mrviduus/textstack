import { authFetch } from './client'
import type { OAuthGrant } from '../lib/mcpConnect'

/** "Connected apps" — OAuth grants the reader gave an assistant (ADR-017). Web and mobile. */

export async function listOAuthGrants(): Promise<OAuthGrant[]> {
  const res = await authFetch<{ items: OAuthGrant[] }>('/me/oauth/grants')
  return res.items
}

export async function revokeOAuthGrant(id: string): Promise<void> {
  await authFetch<void>(`/me/oauth/grants/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
