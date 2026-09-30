import { useEffect, useState } from 'react'
import { Alert, Linking } from 'react-native'
import {
  chooseChat, connectedAssistants, handoffUrl, oauthGrantsApi, type Assistant, type OAuthGrant,
} from '@textstack/shared'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { capabilitiesFor } from '../lib/capabilities'
import { loadGrantsCached, loadReviewAssistant, resetGrantsCache, saveReviewAssistant } from '../lib/chapterReviewLaunch'

type Brief = () => string

/**
 * Which chat a handoff opens — ONE code path for every assistant button (chapter-row Review, the
 * book screen's Assistant menu: Discuss + Review current chapter). Decision in `chooseChat`
 * (@textstack/shared): one connected → straight there; both → the remembered one (a native
 * two-button choice the first time); none → `connect` goes true and the caller shows
 * `ConnectAssistantSheet`. A failed `Linking.openURL` is surfaced, not swallowed.
 *
 * Grants come from one cached request shared by every button (`loadGrantsCached`).
 */
export function useAssistantLauncher({ eager = true }: { eager?: boolean } = {}) {
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const { user } = useAuth()
  const { canConnectAssistant } = capabilitiesFor(user)
  const [grants, setGrants] = useState<OAuthGrant[]>([])
  const [remembered, setRemembered] = useState<Assistant | null>(null)
  const [connect, setConnect] = useState(false)
  const [busy, setBusy] = useState(false)

  // A guest cannot connect an assistant (account-only), so it has none — skip the 403.
  const fetchGrants = () => canConnectAssistant
    ? loadGrantsCached(oauthGrantsApi.listOAuthGrants)
    : Promise.resolve([] as OAuthGrant[])

  const prefetch = () => fetchGrants().then(g => { setGrants(g); return g })

  useEffect(() => {
    let live = true
    void loadReviewAssistant().then(a => { if (live) setRemembered(a) })
    if (eager) void fetchGrants().then(g => { if (live) setGrants(g) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canConnectAssistant, eager])

  const canSwitch = connectedAssistants(grants).length === 2

  const open = (assistant: Assistant, brief: Brief) => {
    Linking.openURL(handoffUrl(assistant, brief())).catch(() => {
      showToast({ message: t('chapterReview.openFailed'), variant: 'error' })
    })
  }

  const remember = (assistant: Assistant) => { setRemembered(assistant); void saveReviewAssistant(assistant) }

  /** Claude or ChatGPT for this brief; the pick is remembered on this device. */
  const choose = (brief: Brief, title = t('chapterReview.pickTitle')) => {
    const pick = (a: Assistant) => { remember(a); open(a, brief) }
    Alert.alert(title, undefined, [
      { text: t('library.assistant.claude'), onPress: () => pick('claude') },
      { text: t('library.assistant.chatgpt'), onPress: () => pick('chatgpt') },
      { text: t('chapterReview.connect.close'), style: 'cancel' },
    ])
  }

  const launch = async (brief: Brief, pickTitle?: string) => {
    if (busy) return
    setBusy(true)
    try {
      const choice = chooseChat(await fetchGrants(), await loadReviewAssistant())
      if (choice.kind === 'open') open(choice.assistant, brief)
      else if (choice.kind === 'none') { resetGrantsCache(); setConnect(true) }
      else choose(brief, pickTitle)
    } finally {
      setBusy(false)
    }
  }

  return { canSwitch, remembered, remember, prefetch, launch, choose, busy, connect, closeConnect: () => setConnect(false) }
}
