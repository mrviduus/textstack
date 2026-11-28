import { useCallback } from 'react'
import { useAuth } from '../context/AuthContext'

/**
 * `withSession(run)`: runs `run` once the reader has a session to upload with. A reader with none gets a guest
 * session (ADR-014: a guest may upload). It waits for the start-up session check first, so a stored session is
 * never replaced by a new guest. When no session can be made (offline, a rate limit, or the device's books
 * belong to an account that must sign in again), the sign-in dialog opens and `run` does not.
 */
export function useUploadSession() {
  const { waitForSession, ensureSession, openAuthModal } = useAuth()
  return useCallback((run: () => void) => {
    void waitForSession()
      .then(ensureSession)
      .then((has) => (has ? run() : openAuthModal()), () => openAuthModal())
  }, [waitForSession, ensureSession, openAuthModal])
}
