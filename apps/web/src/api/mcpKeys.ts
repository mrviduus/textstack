import { authFetch } from './client'
import type { McpKey, CreatedMcpKey } from '@textstack/shared'

export type { McpKey, CreatedMcpKey }

/**
 * Connect keys — the web path.
 *
 * The remote MCP endpoint is stateless and reads a bearer per request, so before this the only thing
 * it could take was a 60-minute access token minted for the local transport. A connector configured
 * with one stopped working inside the hour.
 *
 * The fetch lives here rather than in `@textstack/shared/api` because the web's token is a cookie
 * and the shared client is only initialised by mobile — see `noSharedApiOnWeb.test.ts`. The types and
 * the config template a reader actually copies are shared, so the two platforms cannot show
 * different snippets for the same key.
 */

export async function listMcpKeys(): Promise<McpKey[]> {
  const res = await authFetch<{ items: McpKey[] }>('/me/mcp/keys')
  return res.items
}

export async function createMcpKey(name: string): Promise<CreatedMcpKey> {
  return authFetch<CreatedMcpKey>('/me/mcp/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

export async function revokeMcpKey(id: string): Promise<void> {
  await authFetch<void>(`/me/mcp/keys/${id}`, { method: 'DELETE' })
}
