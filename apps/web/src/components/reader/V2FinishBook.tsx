import { useRef, useState } from 'react'
import { useTranslation } from '../../hooks/useTranslation'

/**
 * The end-of-book block of the web V2 reader (#1266): host UI above the frame, never injected into the book.
 * "Finish book" writes the completion to the server through the host (`onFinish`); a failure is said, and the
 * same button tries again. One write at a time: a second click while it is in flight does nothing.
 */
export function V2FinishBook({ finished, onFinish }: { finished: boolean; onFinish: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'saving' | 'failed'>('idle')
  // Not the state: two clicks in one tick both see the state before the re-render.
  const busy = useRef(false)
  if (finished) return <span role="status" data-testid="v2-finished">{t('v2Reader.finished')}</span>
  const finish = () => {
    if (busy.current) return
    busy.current = true
    setState('saving')
    onFinish().then(() => setState('idle'), (e: unknown) => {
      console.warn('[v2] finish book failed:', e)
      setState('failed')
    }).finally(() => { busy.current = false })
  }
  return (
    <span data-testid="v2-finish">
      {state === 'failed' && <span role="alert">{t('v2Reader.finishFailed')} </span>}
      <button onClick={finish} disabled={state === 'saving'}>
        {state === 'saving' ? t('v2Reader.finishing') : state === 'failed' ? t('v2Reader.retry') : t('v2Reader.finishBook')}
      </button>
    </span>
  )
}
