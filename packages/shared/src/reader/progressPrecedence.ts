/**
 * Local record vs server row: which one is the reader's latest position?
 *
 * The local record's `updatedAt` is this device's clock. The server row's `updatedAt` is the
 * SERVER's clock — comparing the two is the two-clocks bug the server fixed for itself in #695,
 * and a device a minute off read every recent write the wrong way round. So the local stamp is
 * compared only with the server row's `clientUpdatedAt`: the client stamp of the write the server
 * accepted.
 *
 * When the row carries no client stamp (written by an older build, by mark-as-finished, or by an
 * assistant over MCP) there is nothing to compare with, and the rule is web's
 * (`apps/web/src/lib/progressSync.ts` `preferLocalProgress`): a local write the server has not
 * acknowledged (`synced` unset) is this device's latest intent and wins; an acknowledged one
 * defers to the server, whose own last-write-wins has already arbitrated other devices.
 */
export function localProgressWins(
  local: { updatedAt: number; synced?: boolean } | null | undefined,
  server: { clientUpdatedAt?: string | null } | null | undefined,
): boolean {
  if (!local) return false
  if (!server) return true
  const serverClientMs = server.clientUpdatedAt ? Date.parse(server.clientUpdatedAt) : NaN
  // Equal stamps are the same write: the server's copy is as good and is what other devices see.
  if (Number.isFinite(serverClientMs)) return local.updatedAt > serverClientMs
  return !local.synced
}
