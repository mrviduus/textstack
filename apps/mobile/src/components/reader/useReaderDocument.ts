import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { EdgeInsets } from 'react-native-safe-area-context'
import { buildReaderHtml, buildPdfViewerHtml } from '../../lib/readerHtml'
import { pdfDocumentKey, pdfChromeInjectionJs } from '../../lib/pdfViewerChrome'
import {
  readerDocumentKey, readerChromeInjectionJs, latchReaderChrome, readerChromeChanged, type ReaderChrome,
  readerTypographyInjectionJs, readerTypographyChanged, fontFaceKey, type ReaderTypography,
} from '../../lib/readerChrome'
import { API_URL } from '../../lib/api'
import type { useReaderSettings } from '../../hooks/useReaderSettings'
import type { ReaderShellProps } from './readerShellTypes'

type Settings = ReturnType<typeof useReaderSettings>

type Args = Pick<ReaderShellProps,
  | 'original' | 'originalFileUrl' | 'originalInitialPage' | 'htmlChapterSlug' | 'injectJs' | 'reflow' | 'onDocumentRebuild'
> & {
  chapter: { html: string }
  settings: Settings['settings']
  resolvedFontFamily: Settings['resolvedFontFamily']
  resolvedTheme: Settings['resolvedTheme']
  insets: EdgeInsets
  // From useReaderPdf.
  pdfToken: string | null
  pdfTokenReady: boolean
  pdfReloadNonce: number
  isLocalOriginal: boolean
  pdfInitialPageRef: MutableRefObject<number | null>
  currentPdfPageRef: MutableRefObject<number | null>
  pdfIsReloadRef: MutableRefObject<boolean>
  pdfReadyRef: MutableRefObject<boolean>
}

/**
 * The document the WebView shows — the reflow html or the PDF viewer — and what reaches it
 * without a rebuild: chrome (insets, theme) and typography (R4). Also the remount after a dead
 * renderer (M6). Effect order here is load-bearing; see readerR4Wiring.test.ts.
 */
export function useReaderDocument({
  original, originalFileUrl, originalInitialPage, htmlChapterSlug, injectJs, reflow, onDocumentRebuild,
  chapter, settings, resolvedFontFamily, resolvedTheme, insets,
  pdfToken, pdfTokenReady, pdfReloadNonce, isLocalOriginal,
  pdfInitialPageRef, currentPdfPageRef, pdfIsReloadRef, pdfReadyRef,
}: Args) {
  // Safe-area padding + theme colours for whichever document is open (reflow or
  // PDF). A REF, not a memo dependency: these change while the document is open
  // (the status bar hides with the bars, the reader switches theme) and letting
  // them rebuild the template reloads the WebView (PDF: at page 1). Latched to
  // the largest insets seen, then pushed to the live DOM by the effect below.
  // See readerChrome.ts / pdfViewerChrome.ts.
  const chromeRef = useRef<ReaderChrome | null>(null)
  const appliedChromeRef = useRef<ReaderChrome | null>(null)
  const readerAppliedTypographyRef = useRef<ReaderTypography | null>(null)
  // The reflow document has loaded and can take injections. Reset by every rebuild (the html memo).
  const docLoadedRef = useRef(false)
  // The typography the reflow html was built with — what a freshly loaded copy of it shows.
  const builtTypographyRef = useRef<ReaderTypography | null>(null)

  // M6: the OS killed the WebView's renderer (memory pressure, a long PDF). The view is dead —
  // Android needs a NEW one, not a reload — so it is remounted under a new key, at the saved
  // place: the reflow document through the rebuild restore (text anchor, rebuildRestore.ts), the
  // PDF through the same tracked-page bootstrap the silent 401 recovery uses.
  const [webViewKey, setWebViewKey] = useState(0)
  const onRendererGone = useCallback(() => {
    if (original) {
      pdfInitialPageRef.current = currentPdfPageRef.current ?? pdfInitialPageRef.current
      pdfIsReloadRef.current = true
      pdfReadyRef.current = false
    } else {
      onDocumentRebuild()
    }
    setWebViewKey(k => k + 1)
  }, [original, onDocumentRebuild])

  const documentKey = readerDocumentKey({
    chapterSlug: htmlChapterSlug ?? '',
    fontFaceKey: fontFaceKey(resolvedFontFamily),
    htmlLength: chapter.html.length,
  })

  const html = useMemo(
    () => {
      // Chrome and typography are read from refs, deliberately outside the
      // dependency list — see readerChrome.ts for what a rebuild costs here.
      const chrome = chromeRef.current ?? {
        safeArea: { top: insets.top, bottom: insets.bottom },
        backgroundColor: resolvedTheme.backgroundColor,
        textColor: resolvedTheme.textColor,
      }
      chromeRef.current = chrome
      appliedChromeRef.current = chrome  // a fresh document already has it
      const typography = {
        fontFamily: resolvedFontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        textAlign: settings.textAlign,
      }
      readerAppliedTypographyRef.current = typography
      builtTypographyRef.current = typography
      docLoadedRef.current = false  // a new document; onLoadEnd says when it can take injections
      return buildReaderHtml(chapter.html, {
        fontSize: typography.fontSize,
        lineHeight: typography.lineHeight,
        fontFamily: typography.fontFamily,
        textAlign: typography.textAlign,
        backgroundColor: chrome.backgroundColor,
        textColor: chrome.textColor,
      }, htmlChapterSlug, chrome.safeArea)
    },
    // Keyed on document identity ONLY. Insets, colours and typography are absent
    // on purpose; readerChrome.test.ts asserts that absence. A remount after a dead
    // renderer (M6) IS a new document, built with today's typography.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentKey, webViewKey],
  )

  // A rebuild is starting. Told to the persistence hook BEFORE the new document
  // loads, because the fresh document's load event overwrites the one fact that
  // decides what to do about it: which chapter the reader was actually in.
  const lastDocumentKeyRef = useRef(documentKey)
  useEffect(() => {
    if (lastDocumentKeyRef.current === documentKey) return
    lastDocumentKeyRef.current = documentKey
    onDocumentRebuild()
  }, [documentKey, onDocumentRebuild])

  // Typography changes reach the OPEN document instead of rebuilding it. The
  // injection measures, restyles and re-anchors as one operation and acks the
  // restoreId, so the write gate is shut across the reflow.
  //
  // Only into a LOADED document: settings arrive from AsyncStorage while the
  // first one is still loading, and an injection then finds no script to run
  // and is lost — the reader kept the default size for the whole visit. So
  // onLoadEnd applies whatever changed in the meantime (R4).
  const applyTypography = useCallback(() => {
    if (original || !docLoadedRef.current) return
    const next = {
      fontFamily: resolvedFontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      textAlign: settings.textAlign,
    }
    if (!readerTypographyChanged(readerAppliedTypographyRef.current, next)) return
    readerAppliedTypographyRef.current = next
    reflow(id => readerTypographyInjectionJs(next, id))
  }, [original, resolvedFontFamily, settings.fontSize, settings.lineHeight, settings.textAlign, reflow])

  // ADR-012 S4b — the Original-layout PDF document. Rebuilt when the token
  // refreshes (nonce) so a silent 401 recovery reloads at the tracked page.
  const pdfHtml = useMemo(() => {
    if (!original || !originalFileUrl) return ''
    // Chrome is read from the ref, deliberately outside the dependency list.
    const chrome = chromeRef.current ?? {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    }
    chromeRef.current = chrome
    appliedChromeRef.current = chrome  // a fresh document already has it
    // Same-origin, both ways. Streaming: an absolute API URL with `baseUrl` set
    // to the API origin. Local: the bare filename with `baseUrl` set to the
    // file's own directory — a `file://` document may read a sibling file, but
    // not one reached from an http(s) base, and the alternative
    // (allowUniversalAccessFromFileURLs) opens the whole disk to the page.
    const documentUrl = isLocalOriginal
      ? originalFileUrl.slice(originalFileUrl.lastIndexOf('/') + 1)
      : originalFileUrl
    return buildPdfViewerHtml(documentUrl, pdfToken, {
      theme: {
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        fontFamily: resolvedFontFamily,
        textAlign: settings.textAlign,
        backgroundColor: chrome.backgroundColor,
        textColor: chrome.textColor,
      },
      initialPage: pdfInitialPageRef.current ?? originalInitialPage ?? null,
      safeArea: chrome.safeArea,
    })
    // Keyed on document identity ONLY. Insets and theme are absent on purpose —
    // that absence is the fix, and pdfViewerChrome.test.ts asserts it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, pdfDocumentKey({
    fileUrl: originalFileUrl ?? '',
    token: pdfToken,
    nonce: pdfReloadNonce + webViewKey,
    initialPage: pdfInitialPageRef.current ?? originalInitialPage ?? null,
  })])

  // baseUrl = API origin so pdf.js lazy Range requests are same-origin (the
  // Bearer travels in httpHeaders, no CORS preflight). Reflow uses inline html.
  const webViewSource = useMemo(() => {
    if (original) {
      if (!pdfTokenReady) {
        return { html: `<!DOCTYPE html><html><body style="background:${resolvedTheme.backgroundColor};margin:0"></body></html>` }
      }
      return {
        html: pdfHtml,
        baseUrl: isLocalOriginal
          ? originalFileUrl!.slice(0, originalFileUrl!.lastIndexOf('/') + 1)
          : API_URL,
      }
    }
    return { html }
    // `resolvedTheme.backgroundColor` only paints the pre-token placeholder, and
    // is intentionally NOT a dependency: once the token is ready this object must
    // change only when `pdfHtml` does, or a theme switch reloads the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [original, pdfTokenReady, pdfHtml, html, isLocalOriginal, originalFileUrl])

  // A new source is a new document even when the reflow html is the same memo — PDF → "Read as
  // text" swaps the source, not the html. It takes no injections until its onLoadEnd, and it is
  // styled as the html was built, not as later injections restyled the one before it.
  useEffect(() => {
    docLoadedRef.current = false
    readerAppliedTypographyRef.current = builtTypographyRef.current
  }, [webViewSource])
  // Declared after the reset above, so a change in the same render waits for onLoadEnd.
  useEffect(() => { applyTypography() }, [applyTypography])

  // Chrome changes reach the OPEN document instead of rebuilding it. This is the
  // other half of the fix: the memo above stopped depending on insets and theme,
  // so something still has to apply them when they change mid-read — the status
  // bar hiding with the bars, or the reader switching to dark mode.
  useEffect(() => {
    const next = latchReaderChrome(chromeRef.current, {
      safeArea: { top: insets.top, bottom: insets.bottom },
      backgroundColor: resolvedTheme.backgroundColor,
      textColor: resolvedTheme.textColor,
    })
    chromeRef.current = next
    if (!readerChromeChanged(appliedChromeRef.current, next)) return
    appliedChromeRef.current = next
    injectJs(original ? pdfChromeInjectionJs(next) : readerChromeInjectionJs(next))
  }, [original, insets.top, insets.bottom, resolvedTheme.backgroundColor, resolvedTheme.textColor, injectJs])

  return { webViewKey, onRendererGone, webViewSource, docLoadedRef, applyTypography }
}
