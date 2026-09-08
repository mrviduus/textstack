import { buildHandoffBrief, handoffUrl, type HandoffBook } from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * "Discuss with an assistant" — two links, not an integration.
 *
 * The reader picks Claude or ChatGPT; we open a new conversation there with an
 * opening message already written. See `assistantHandoff.ts` in @textstack/shared for why this is
 * a link and what the brief does and does not carry.
 *
 * `target="_blank"` with `rel="noopener noreferrer"`: these are third-party
 * origins and must not get a handle on this window.
 */
export function DiscussWithAssistant(props: HandoffBook) {
  const { t } = useTranslation()
  const brief = buildHandoffBrief(props)

  return (
    <div className="discuss-assistant">
      <div className="discuss-assistant__label">{t('library.discuss.label')}</div>
      <div className="discuss-assistant__actions">
        <a
          className="discuss-assistant__btn"
          href={handoffUrl('claude', brief)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('library.discuss.claude')}
        </a>
        <a
          className="discuss-assistant__btn"
          href={handoffUrl('chatgpt', brief)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('library.discuss.chatgpt')}
        </a>
      </div>
      <p className="discuss-assistant__hint">{t('library.discuss.hint')}</p>
    </div>
  )
}
