import { authFetch } from './client'

/**
 * Connect keys — the credential a reader pastes into Claude or ChatGPT so it can reach their books.
 *
 * The remote MCP endpoint is stateless and reads a bearer per request, so before this the only thing
 * it could take was a 60-minute access token minted for the local transport. A connector configured
 * with one stopped working inside the hour.
 */

export interface McpKey {
  id: string
  name: string
  /** The clear-text head of the key. Enough to match a row against a config file, useless alone. */
  prefix: string
  createdAt: string
  /**
   * Null until the key has authenticated a request; written at most hourly, so it means "recently"
   * rather than "exactly then". This is the field that answers "is the connector I just set up
   * actually talking to us".
   */
  lastUsedAt: string | null
  revokedAt: string | null
}

/** The only response that ever carries the key itself. It is unrecoverable afterwards. */
export interface CreatedMcpKey extends Omit<McpKey, 'lastUsedAt' | 'revokedAt'> {
  key: string
}

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

/**
 * A connector config with the key already in it, ready to paste. Two shapes because the clients
 * differ: Claude Desktop takes a JSON file, ChatGPT and claude.ai take a URL plus a header in their
 * own connector form.
 */
export function claudeDesktopConfig(key: string): string {
  return `{
  "mcpServers": {
    "textstack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://textstack.app/mcp",
               "--header", "Authorization: Bearer ${key}"]
    }
  }
}`
}
