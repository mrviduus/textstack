import { authFetch } from './client'
import type { McpKey, CreatedMcpKey } from '../lib/mcpConnect'

/** Connect keys (`tsk_…`) for the remote MCP endpoint. Web and mobile both use this. */

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
