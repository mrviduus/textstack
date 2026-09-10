/**
 * The shape of a connect key, and the pure text a reader copies to use one.
 *
 * <p>Lives here rather than in either app's api folder because both clients need the same config
 * template — a key minted on the phone is the same key in Claude Desktop, so handing out two
 * different snippets would be two chances to be wrong. The network calls stay per-platform: the web
 * authenticates with a cookie and mobile with a bearer, and mixing those two layers is exactly the
 * defect that kept the insights section from ever rendering on the web.</p>
 */

export interface McpKey {
  id: string
  name: string
  /** The clear-text head of the key — enough to match a row against a config file, useless alone. */
  prefix: string
  createdAt: string
  /**
   * Null until the key has authenticated a request. Written at most hourly, so it means "recently"
   * rather than "exactly then" — and it is the only signal a reader has that the connector they just
   * configured is actually reaching us.
   */
  lastUsedAt: string | null
  revokedAt: string | null
}

/** The only response that ever carries the key itself. It is unrecoverable afterwards. */
export interface CreatedMcpKey extends Omit<McpKey, 'lastUsedAt' | 'revokedAt'> {
  key: string
}

/** The remote endpoint. nginx routes all of `/mcp/*` to the bridge container. */
export const MCP_ENDPOINT = 'https://textstack.app/mcp'

/**
 * A connector config with the key already substituted, ready to paste.
 *
 * <p>Via `mcp-remote` because Claude Desktop's config speaks stdio: it launches a command, and this
 * one proxies to the HTTP endpoint carrying the key as a bearer. A config the reader has to hand-edit
 * to insert their key is the step this whole feature exists to remove.</p>
 */
export function claudeDesktopConfig(key: string): string {
  return `{
  "mcpServers": {
    "textstack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_ENDPOINT}",
               "--header", "Authorization: Bearer ${key}"]
    }
  }
}`
}

/**
 * A label the reader can tell apart later without being asked to invent one now.
 *
 * <p>Asking for a name before the key exists puts a form between them and the thing they came for.
 * The date is what actually distinguishes two keys in practice — "the one I made for my laptop" is
 * remembered by when, not by what it was called.</p>
 *
 * <p>Takes the clock so it stays a pure function; callers pass `new Date()`.</p>
 */
export function defaultKeyName(now: Date): string {
  return `Assistant · ${now.toISOString().slice(0, 10)}`
}

/** The keys worth showing: revoked ones authenticate nothing and only make the list harder to read. */
export function liveKeys(keys: readonly McpKey[]): McpKey[] {
  return keys.filter(k => !k.revokedAt)
}
