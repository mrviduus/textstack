import type { UserDto } from '@textstack/shared'
import { capabilitiesFor } from './capabilities'

/**
 * What leaving the session means for this viewer.
 *
 * - `immediate` — clear the tokens and go. Nothing is lost that cannot be got
 *   back by signing in again.
 * - `delete-guest-data` — there is no "sign out" for a guest, only "Delete guest
 *   data": a destructive confirm, then `DELETE /me/account` on the guest row, then
 *   the local sign-out. See `deleteGuestData`.
 */
export type SignOutIntent = 'immediate' | 'delete-guest-data'

/**
 * Sign-out is two different operations wearing one label.
 *
 * For an account it is what it looks like: `signOut()` deletes `access_token`,
 * `refresh_token` and `user` from SecureStore, and the email + password get all
 * of it back on any device.
 *
 * For a guest those same three keys are the ONLY handle that exists on the
 * account — the email is server-generated (`guest-<hex>@guest.local`) and there
 * is no password. It used to ship as "Sign out" behind a confirm that admitted
 * it meant delete — while leaving the row on the server, kept forever by
 * `GuestCleanupWorker` (which spares any guest holding data) and unreachable by
 * anyone. Now it is named for what it is and actually deletes the row.
 *
 * Pure, and delegating to `capabilitiesFor` rather than re-deriving `isGuest` —
 * a second copy of the policy is how the pencil-icon bug on this same screen
 * happened.
 */
export function signOutIntent(user: UserDto | null): SignOutIntent {
  return capabilitiesFor(user).canSignOutSilently ? 'immediate' : 'delete-guest-data'
}

/**
 * "Delete guest data", after the confirm: delete the guest row on the server
 * (best-effort), then sign out locally — ALWAYS. Offline, a 5xx, an expired
 * session or no token at all must not leave the reader stuck as a guest they
 * asked to remove; the worst case is the old behaviour (an orphaned row the
 * cleanup worker may keep), never a dead button.
 *
 * Dependencies injected so the order and the always-sign-out are assertable
 * without React Native.
 */
export async function deleteGuestData(deps: {
  getToken: () => Promise<string | null>
  deleteAccount: (token: string) => Promise<void>
  signOut: () => Promise<void>
}): Promise<void> {
  try {
    const token = await deps.getToken()
    if (token) await deps.deleteAccount(token)
  } catch {
    // Best-effort by design — see above.
  }
  await deps.signOut()
}
