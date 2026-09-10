import { authFetch } from './client'
import type { McpKey, CreatedMcpKey } from '../lib/mcpConnect'

/**
 * Connect keys over the shared api client — the mobile path.
 *
 * <p>The web app has its own copy in `apps/web/src/api/mcpKeys.ts` on its own `authFetch`, because
 * its token lives in a cookie rather than a header and this client is only initialised by mobile
 * (`initApi`). That duplication is deliberate and guarded: `apps/web/src/__tests__/noSharedApiOnWeb.test.ts`
 * fails if a web source ever imports one of these. The types and the config template both sides show
 * are shared, in `../lib/mcpConnect`, so the two cannot drift on anything a reader sees.</p>
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
  await authFetch<void>(`/me/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
