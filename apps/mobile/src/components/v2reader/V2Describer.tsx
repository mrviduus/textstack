// #1426: a book's details and cover read by the reader page before it is uploaded (Android). The page parses untrusted
// books, so it runs in its own hidden WebView with the reader's props (pageWebView.ts), reads the staged file through
// the interceptor (`describe(id, url)`), and only what `readDescribed` takes comes back. Mounted only while a describe
// runs. Never throws: null for no answer in DESCRIBE_MS, a file the page does not read, or any failure.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { uuid } from 'expo-modules-core'
import type { FileDetails } from '@textstack/shared'
import { bookUrl } from '../../../../../packages/reader/src/bookOrigin.mjs'
import { readDescribed } from '../../../../../packages/reader/src/describe.mjs'
import { nonceFromUuid } from '../../lib/v2reader/hostStorage'
import { DESCRIBE_MS, PAGE_WEBVIEW_PROPS, pageSource } from './pageWebView'

type Job = { id: string; url: string; nonce: string; done: (d: FileDetails | null) => void }

/**
 * `[element, describe]`: render `element` anywhere in the screen; `describe(file)` takes a name under `files/v2/`
 * (`staging/<ms>.epub`) and resolves to its details and cover, or null. One at a time: a new call answers the
 * previous one null.
 */
export function useV2Describer(): [ReactNode, (file: string) => Promise<FileDetails | null>] {
  const [job, setJob] = useState<Job | null>(null)
  const current = useRef<Job | null>(null)
  const describe = useCallback((file: string) => new Promise<FileDetails | null>((resolve) => {
    const url = bookUrl(file)
    if (!url) return resolve(null)
    current.current?.done(null)
    const mine: Job = {
      id: uuid.v4(),
      url,
      nonce: nonceFromUuid(uuid.v4()),
      done: (d) => {
        clearTimeout(timer)
        if (current.current === mine) {
          current.current = null
          setJob(null)
        }
        resolve(d)
      },
    }
    const timer = setTimeout(() => mine.done(null), DESCRIBE_MS)
    current.current = mine
    setJob(mine)
  }), [])
  return [job && <V2Describer key={job.id} job={job} />, describe]
}

function V2Describer({ job }: { job: Job }) {
  const webView = useRef<WebView>(null)
  const source = useMemo(() => pageSource(job.nonce), [job])
  const onMessage = (event: WebViewMessageEvent) => {
    let m: any
    try { m = JSON.parse(event.nativeEvent.data) } catch { return }
    if (m?.type === 'ready') webView.current?.injectJavaScript(`window.__fol.describe(${JSON.stringify(job.id)},${JSON.stringify(job.url)});true`)
    else if (m?.type === 'described') {
      const d = readDescribed(m)
      if (d?.id === job.id) job.done(d.meta ? d : null)
    }
  }
  return (
    <View style={styles.offscreen} pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <WebView
        ref={webView}
        {...PAGE_WEBVIEW_PROPS}
        source={source}
        onMessage={onMessage}
        onRenderProcessGone={() => job.done(null)}
        onError={() => job.done(null)}
      />
    </View>
  )
}

// Off screen, not hidden: the page lays out and draws the cover on a canvas.
const styles = StyleSheet.create({
  offscreen: { position: 'absolute', left: -10000, top: 0, width: 1, height: 1, opacity: 0 },
})
