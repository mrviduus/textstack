import { describe, it, expect } from 'vitest'
import { claudeDesktopConfig, defaultKeyName, liveKeys, MCP_ENDPOINT, type McpKey } from './mcpConnect'

const key = (over: Partial<McpKey> = {}): McpKey => ({
  id: 'k1',
  name: 'Assistant · 2026-09-10',
  prefix: 'tsk_abcdef',
  createdAt: '2026-09-10T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

describe('claudeDesktopConfig', () => {
  it('is valid JSON with the key already in it', () => {
    // The entire point: copy this, paste it, done. A snippet the reader has to hand-edit to insert
    // their key is the step this feature exists to remove — and a broken one is worse, because the
    // client fails at launch with nothing that names the cause.
    const raw = 'tsk_abcdefghijklmnopqrstuvwxyz0123456789ABC'
    const config = claudeDesktopConfig(raw)

    const parsed = JSON.parse(config)
    const args: string[] = parsed.mcpServers.textstack.args

    expect(args).toContain(MCP_ENDPOINT)
    expect(args.join(' ')).toContain(`Bearer ${raw}`)
  })

  it('survives a key containing base64url characters', () => {
    // Keys are base64url, so `-` and `_` are ordinary content. They must not need escaping, and must
    // come back byte-identical — a config that silently mangles one character authenticates nothing
    // and says nothing about why.
    const raw = 'tsk_-_-_aA09-_zZ'
    const parsed = JSON.parse(claudeDesktopConfig(raw))
    expect(parsed.mcpServers.textstack.args.join(' ')).toContain(`Bearer ${raw}`)
  })

  it('points at the remote endpoint, not a local path', () => {
    expect(MCP_ENDPOINT).toBe('https://textstack.app/mcp')
    expect(claudeDesktopConfig('tsk_x')).not.toContain('localhost')
  })
})

describe('defaultKeyName', () => {
  it('dates the key so two of them can be told apart', () => {
    expect(defaultKeyName(new Date('2026-09-10T22:31:00Z'))).toBe('Assistant · 2026-09-10')
  })

  it('takes the clock as an argument so it stays pure', () => {
    const at = new Date('2026-01-02T03:04:05Z')
    expect(defaultKeyName(at)).toBe(defaultKeyName(at))
  })
})

describe('liveKeys', () => {
  it('drops revoked keys, which authenticate nothing', () => {
    const rows = [key({ id: 'live' }), key({ id: 'dead', revokedAt: '2026-09-10T01:00:00Z' })]
    expect(liveKeys(rows).map(k => k.id)).toEqual(['live'])
  })

  it('keeps a key that has never been used — never used is not the same as revoked', () => {
    // A key minted a minute ago has lastUsedAt null. Filtering on "unused" instead of "revoked" would
    // hide the key the reader is in the middle of pasting.
    expect(liveKeys([key({ lastUsedAt: null })])).toHaveLength(1)
  })

  it('does not mutate its input', () => {
    const rows = [key({ id: 'a' }), key({ id: 'b', revokedAt: 'x' })]
    liveKeys(rows)
    expect(rows).toHaveLength(2)
  })
})
