import { authFetch, API_BASE, ApiError } from './client'
import { oauthGrantsApi, type OAuthGrant } from '@textstack/shared'

export type { OAuthGrant }

/**
 * OAuth for the MCP endpoint (ADR-017) — the web half: the consent page and "Connected apps".
 * Approve/deny return the client's redirect URI (with code or error); the caller navigates to it.
 */

export type OAuthRequestStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface OAuthConsentRequest {
  id: string
  clientName: string
  clientId: string
  redirectHost: string
  scope: string
  scopeDescription: string
  status: OAuthRequestStatus
  expiresAt: string
}

/** No auth: a signed-out visitor must still see who is asking. Unknown id → ApiError(404). */
export async function getOAuthRequest(id: string): Promise<OAuthConsentRequest> {
  const res = await fetch(`${API_BASE}/oauth/requests/${encodeURIComponent(id)}`, { credentials: 'include' })
  if (!res.ok) throw new ApiError(res.status, `API error: ${res.status}`)
  return res.json()
}

const decide = async (path: string, requestId: string): Promise<string> => {
  const res = await authFetch<{ redirect: string }>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId }),
  })
  return res.redirect
}

/** Throws ApiError: 401 signed out, 403 `account_required` (guest), 400 `request_<status>`. */
export const approveOAuthRequest = (requestId: string) => decide('/oauth/authorize/approve', requestId)
export const denyOAuthRequest = (requestId: string) => decide('/oauth/authorize/deny', requestId)

// "Connected apps" — the shared client (cookie mode on web, see ./client).
export const { listOAuthGrants, revokeOAuthGrant } = oauthGrantsApi
