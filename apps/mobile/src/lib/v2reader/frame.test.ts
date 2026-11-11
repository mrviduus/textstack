import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FRAME_NONCE_PLACEHOLDER, V2_READER_FRAME_HEADERS, V2_READER_FRAME_PATH, V2_READER_SCRIPT_HEADERS, V2_READER_SCRIPT_PATH,
  fillNonce, serveV2ReaderFrame, v2ReaderFrameFiles,
} from './frame.mjs'
import { v2ReaderPageHtml } from './v2ReaderPage.generated'

// #1225: the web frame is a no-store shell (CSP, shim, nonce) + the page code as one content-hashed script.
const NONCE = '0123456789abcdef0123456789abcdef'
const { shell, script, scriptPath } = v2ReaderFrameFiles()
const count = (s: string, sub: string) => s.split(sub).length - 1

/** A fake Node response: what the handler wrote. */
function serve(url: string, method = 'GET') {
  const out: { handled: boolean; status?: number; headers?: Record<string, string>; body?: string } = { handled: false }
  const res = {
    writeHead(status: number, headers: Record<string, string>) { Object.assign(out, { status, headers }); return res },
    end(body?: string) { out.body = body },
  }
  out.handled = serveV2ReaderFrame({ url, method }, res)
  return out
}

describe('v2ReaderFrameFiles (frame.mjs)', () => {
  it('shell_CarriesOnlyThePlaceholder_InItsCspAndBothScripts_AndNoPageCode', () => {
    expect(count(shell, FRAME_NONCE_PLACEHOLDER)).toBe(3)
    expect(shell).toContain(`script-src 'nonce-${FRAME_NONCE_PLACEHOLDER}'`)
    expect(shell).not.toContain('__V2_READER_NONCE__')
    expect(shell).not.toContain('__TS_FORMATS')
    expect(shell.length).toBeLessThan(4096)
  })

  it('shellAndScript_ReassembleTheInlinePage_ByteForByte', () => {
    const filled = fillNonce(shell, NONCE)
    const tags = filled.match(/<script nonce="[0-9a-f]{32}">[\s\S]*?<\/script><script [^>]*><\/script>/)
    expect(tags).not.toBeNull()
    expect(filled.replace(tags![0], () => `<script nonce="${NONCE}">${script}</script>`)).toBe(v2ReaderPageHtml(NONCE))
  })

  it('scriptPath_IsItsContentHash_AndTheShellPinsItsIntegrity', () => {
    const sha = createHash('sha384').update(script).digest()
    expect(scriptPath).toMatch(V2_READER_SCRIPT_PATH)
    expect(scriptPath).toBe(`/reader-v2/page.${sha.toString('hex').slice(0, 16)}.js`)
    expect(shell).toContain(`<script nonce="${FRAME_NONCE_PLACEHOLDER}" src="${scriptPath}" integrity="sha384-${sha.toString('base64')}"></script>`)
  })
})

describe('fillNonce (frame.mjs)', () => {
  it('fillNonce_NotNginxRequestIdForm_Throws', () => {
    for (const bad of ['', NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, 'q7Rk2mW9xLpA4vBn8cZt0g==', FRAME_NONCE_PLACEHOLDER, '__V2_READER_NONCE__'])
      expect(() => fillNonce(shell, bad), bad).toThrow()
  })

  it('fillNonce_TemplateWithoutPlaceholder_Throws', () => {
    expect(() => fillNonce('<html></html>', NONCE)).toThrow(/no nonce placeholder/)
  })
})

describe('serveV2ReaderFrame (frame.mjs)', () => {
  it('shell_FrameHeaders_AndAFreshNoncePerResponse', () => {
    const [a, b] = [serve(`${V2_READER_FRAME_PATH}?x=1`), serve(V2_READER_FRAME_PATH)]
    expect(a).toMatchObject({ handled: true, status: 200, headers: V2_READER_FRAME_HEADERS })
    const nonceOf = (body?: string) => body?.match(/script-src 'nonce-([0-9a-f]{32})'/)?.[1]
    expect(nonceOf(a.body)).toBeTruthy()
    expect(nonceOf(a.body)).not.toBe(nonceOf(b.body))
    expect(a.body).not.toContain(FRAME_NONCE_PLACEHOLDER)
  })

  it('script_ImmutableJsHeaders_AndTheExactBytes', () => {
    expect(serve(scriptPath)).toEqual({ handled: true, status: 200, headers: V2_READER_SCRIPT_HEADERS, body: script })
    expect(V2_READER_SCRIPT_HEADERS['Cache-Control']).toContain('immutable')
  })

  it('head_NoBody', () => {
    expect(serve(scriptPath, 'HEAD')).toMatchObject({ status: 200, body: undefined })
    expect(serve(V2_READER_FRAME_PATH, 'HEAD')).toMatchObject({ status: 200, body: undefined })
  })

  it('otherPathUnderTheDir_404_NeverTheSpa', () => {
    expect(serve('/reader-v2/page.0000000000000000.js')).toMatchObject({ handled: true, status: 404 })
    expect(serve('/reader-v2/')).toMatchObject({ handled: true, status: 404 })
  })

  it('outsideTheDir_NotHandled_AndOtherMethods405', () => {
    expect(serve('/en/library').handled).toBe(false)
    expect(serve('/reader-v2-other/frame.html').handled).toBe(false)
    expect(serve(V2_READER_FRAME_PATH, 'POST')).toMatchObject({ handled: true, status: 405 })
  })
})
