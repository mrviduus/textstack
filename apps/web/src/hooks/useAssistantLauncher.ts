import { useEffect, useState } from 'react'
import {
  REVIEW_ASSISTANT_KEY, chooseChat, connectedAssistants, handoffUrl, parseAssistant,
  type Assistant, type ChatChoice, type OAuthGrant,
} from '@textstack/shared'
import { listOAuthGrants } from '../api/oauth'

/**
 * Which chat a handoff opens — ONE code path for every assistant button (chapter-row Review, the
 * book page's Assistant menu: Discuss + Review current chapter). Decision in `chooseChat`
 * (@textstack/shared): one assistant connected → straight there; both → the remembered one, or a
 * pick the first time; none → the connect dialog instead of a chat that cannot reach TextStack.
 *
 * The grants are fetched once per page and shared by every button on it (a chapter list has dozens),
 * and kept synchronously so the click can `window.open` inside the user gesture — an open after an
 * await is what popup blockers eat.
 */
let cachedGrants: OAuthGrant[] | null = null
let grantsPromise: Promise<OAuthGrant[]> | null = null

function loadGrants(): Promise<OAuthGrant[]> {
  grantsPromise ??= listOAuthGrants()
    .then(g => (cachedGrants = g))
    // A guest (no account → no grants) or a failed call both mean "nothing we can open".
    .catch(() => (cachedGrants = []))
  return grantsPromise
}

/** Forget the grants — after the connect dialog, the reader may be about to connect one. */
function resetGrants() { cachedGrants = null; grantsPromise = null }

/** Test seam. */
export const __resetAssistantGrants = resetGrants

function readRemembered(): Assistant | null {
  try { return parseAssistant(localStorage.getItem(REVIEW_ASSISTANT_KEY)) } catch { return null }
}

type Brief = () => string

/**
 * `eager`: fetch the grants on mount (the chapter-row button draws its ▾ from them). The book page's
 * menu passes false and calls `prefetch` when opened — that page is prerendered and seen signed out,
 * where a mount-time call is only a 401.
 */
export function useAssistantLauncher({ eager = true }: { eager?: boolean } = {}) {
  const [grants, setGrants] = useState<OAuthGrant[] | null>(cachedGrants)
  const [remembered, setRemembered] = useState<Assistant | null>(readRemembered)
  // Both connected, nothing remembered: the brief waits here for the reader's pick.
  const [pending, setPending] = useState<{ brief: Brief } | null>(null)
  const [connect, setConnect] = useState(false)

  const prefetch = () => loadGrants().then(g => { setGrants(g); return g })

  useEffect(() => {
    if (!eager) return
    let live = true
    void loadGrants().then(g => { if (live) setGrants(g) })
    return () => { live = false }
  }, [eager])

  const canSwitch = !!grants && connectedAssistants(grants).length === 2

  const open = (assistant: Assistant, brief: Brief) =>
    window.open(handoffUrl(assistant, brief()), '_blank', 'noopener,noreferrer')

  const remember = (assistant: Assistant) => {
    try { localStorage.setItem(REVIEW_ASSISTANT_KEY, assistant) } catch { /* private mode: just don't remember */ }
    setRemembered(assistant)
  }

  const decide = (g: OAuthGrant[], brief: Brief): ChatChoice['kind'] => {
    const choice = chooseChat(g, readRemembered())
    if (choice.kind === 'open') open(choice.assistant, brief)
    else if (choice.kind === 'pick') setPending({ brief })
    else { resetGrants(); setConnect(true) }
    return choice.kind
  }

  /** Open the chat for this brief. Synchronous when the grants are already known (popup-safe). */
  const launch = (brief: Brief): Promise<ChatChoice['kind']> =>
    cachedGrants ? Promise.resolve(decide(cachedGrants, brief)) : loadGrants().then(g => decide(g, brief))

  /** The pick for a pending brief: remembered, then opened. */
  const pick = (assistant: Assistant) => {
    remember(assistant)
    const p = pending
    setPending(null)
    if (p) open(assistant, p.brief)
  }

  return {
    grants, canSwitch, remembered, remember, prefetch, launch, pick,
    pending: pending !== null,
    /** Toggle the pick menu for this brief (the ▾ switch). */
    choose: (brief: Brief) => setPending(p => (p ? null : { brief })),
    cancelPick: () => setPending(null),
    connect,
    closeConnect: () => setConnect(false),
  }
}
