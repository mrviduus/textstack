import { useRef, useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'
import { NO_PLACE_YET } from '../../lib/v2ReaderSync'

/**
 * The end-of-book block of the web V2 reader (#1266): host UI over the frame, never injected into the book.
 * "Finish book" writes the completion to the server through the host (`onFinish`); a failure is said, and the
 * same button tries again. One write at a time: a second click while it is in flight does nothing.
 */
export function V2FinishBook({ finished, onFinish }: { finished: boolean; onFinish: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'saving' | 'failed' | 'noPlace'>('idle')
  // Not the state: two clicks in one tick both see the state before the re-render.
  const busy = useRef(false)
  if (finished) return <span role="status" data-testid="v2-finished">{t('v2Reader.finished')}</span>
  const finish = () => {
    if (busy.current) return
    busy.current = true
    setState('saving')
    onFinish().then(() => setState('idle'), (e: unknown) => {
      console.warn('[v2] finish book failed:', e)
      // No place saved yet (a book never moved in): say what to do, not a connection problem.
      setState(e instanceof Error && e.message === NO_PLACE_YET ? 'noPlace' : 'failed')
    }).finally(() => { busy.current = false })
  }
  return (
    <span data-testid="v2-finish">
      {(state === 'failed' || state === 'noPlace') && <span role="alert">{t(state === 'noPlace' ? 'v2Reader.finishNoPlace' : 'v2Reader.finishFailed')} </span>}
      <button onClick={finish} disabled={state === 'saving'}>
        {state === 'saving' ? t('v2Reader.finishing') : state === 'idle' ? t('v2Reader.finishBook') : t('v2Reader.retry')}
      </button>
    </span>
  )
}
