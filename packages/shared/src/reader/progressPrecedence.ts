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
 *
 * The server stores a client stamp CLAMPED to its own now + {@link MAX_CLIENT_SKEW_MS}
 * (`Application.ReadingTracking.ProgressClock`). A device running fast had its acknowledged write
 * stored clamped, so its raw local stamp read as newer than that very write. An acknowledged
 * (`synced`) local stamp is therefore clamped the same way before the comparison, with the row's
 * server-clock `updatedAt` as the server's now — used only as that ceiling, never compared. An
 * unsynced one is not: it has not reached the server, whose clock at arrival will be later still.
 * Left as is: a device fast by more than the skew still beats another device's write made within
 * the skew of its own, exactly as it does on the server.
 */
export function localProgressWins(
  local: { updatedAt: number; synced?: boolean } | null | undefined,
  server: { clientUpdatedAt?: string | null; updatedAt?: string | null } | null | undefined,
): boolean {
  if (!local) return false
  if (!server) return true
  const serverClientMs = server.clientUpdatedAt ? Date.parse(server.clientUpdatedAt) : NaN
  if (!Number.isFinite(serverClientMs)) return !local.synced
  const serverNowMs = server.updatedAt ? Date.parse(server.updatedAt) : NaN
  const localMs = local.synced && Number.isFinite(serverNowMs)
    ? Math.min(local.updatedAt, serverNowMs + MAX_CLIENT_SKEW_MS)
    : local.updatedAt
  // Equal stamps are the same write: the server's copy is as good and is what other devices see.
  return localMs > serverClientMs
}

/** Mirror of `ProgressClock.MaxClientSkew` (server). */
export const MAX_CLIENT_SKEW_MS = 5 * 60_000
