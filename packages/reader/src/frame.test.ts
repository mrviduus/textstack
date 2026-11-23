import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FRAME_NONCE_PLACEHOLDER, READER_FRAME_HEADERS, READER_FRAME_PATH, READER_SCRIPT_HEADERS, READER_SCRIPT_PATH,
  fillNonce, serveReaderFrame, readerDistFiles, readerFrameFiles,
} from './frame.mjs'
import { readerPageHtml } from './readerPage.generated'

// #1225: the web frame is a no-store shell (CSP, shim, nonce) + the page code as one content-hashed script.
const NONCE = '0123456789abcdef0123456789abcdef'
const { shell, script, scriptPath } = readerFrameFiles()
const count = (s: string, sub: string) => s.split(sub).length - 1

/** A fake Node response: what the handler wrote. */
function serve(url: string, method = 'GET') {
  const out: { handled: boolean; status?: number; headers?: Record<string, string>; body?: string } = { handled: false }
  const res = {
    writeHead(status: number, headers: Record<string, string>) { Object.assign(out, { status, headers }); return res },
    end(body?: string) { out.body = body },
  }
  out.handled = serveReaderFrame({ url, method }, res)
  return out
}

describe('readerFrameFiles (frame.mjs)', () => {
  it('shell_CarriesOnlyThePlaceholder_InItsCspAndBothScripts_AndNoPageCode', () => {
    expect(count(shell, FRAME_NONCE_PLACEHOLDER)).toBe(3)
    expect(shell).toContain(`script-src 'nonce-${FRAME_NONCE_PLACEHOLDER}'`)
    expect(shell).not.toContain('__READER_NONCE__')
    expect(shell).not.toContain('__TS_FORMATS')
    expect(shell.length).toBeLessThan(4096)
  })

  it('shellAndScript_ReassembleTheInlinePage_ByteForByte', () => {
    const filled = fillNonce(shell, NONCE)
    const tags = filled.match(/<script nonce="[0-9a-f]{32}">[\s\S]*?<\/script><script [^>]*><\/script>/)
    expect(tags).not.toBeNull()
    expect(filled.replace(tags![0], () => `<script nonce="${NONCE}">${script}</script>`)).toBe(readerPageHtml(NONCE))
  })

  it('scriptPath_IsItsContentHash_AndTheShellPinsItsIntegrity', () => {
    const sha = createHash('sha384').update(script).digest()
    expect(scriptPath).toMatch(READER_SCRIPT_PATH)
    expect(scriptPath).toBe(`/reader/page.${sha.toString('hex').slice(0, 16)}.js`)
    expect(shell).toContain(`<script nonce="${FRAME_NONCE_PLACEHOLDER}" src="${scriptPath}" integrity="sha384-${sha.toString('base64')}"></script>`)
  })
})

describe('fillNonce (frame.mjs)', () => {
  it('fillNonce_NotNginxRequestIdForm_Throws', () => {
    for (const bad of ['', NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, 'q7Rk2mW9xLpA4vBn8cZt0g==', FRAME_NONCE_PLACEHOLDER, '__READER_NONCE__'])
      expect(() => fillNonce(shell, bad), bad).toThrow()
  })

  it('fillNonce_TemplateWithoutPlaceholder_Throws', () => {
    expect(() => fillNonce('<html></html>', NONCE)).toThrow(/no nonce placeholder/)
  })
})

describe('serveReaderFrame (frame.mjs)', () => {
  it('shell_FrameHeaders_AndAFreshNoncePerResponse', () => {
    const [a, b] = [serve(`${READER_FRAME_PATH}?x=1`), serve(READER_FRAME_PATH)]
    expect(a).toMatchObject({ handled: true, status: 200, headers: READER_FRAME_HEADERS })
    const nonceOf = (body?: string) => body?.match(/script-src 'nonce-([0-9a-f]{32})'/)?.[1]
    expect(nonceOf(a.body)).toBeTruthy()
    expect(nonceOf(a.body)).not.toBe(nonceOf(b.body))
    expect(a.body).not.toContain(FRAME_NONCE_PLACEHOLDER)
  })

  it('script_ImmutableJsHeaders_AndTheExactBytes', () => {
    expect(serve(scriptPath)).toEqual({ handled: true, status: 200, headers: READER_SCRIPT_HEADERS, body: script })
    expect(READER_SCRIPT_HEADERS['Cache-Control']).toContain('immutable')
  })

  it('head_NoBody', () => {
    expect(serve(scriptPath, 'HEAD')).toMatchObject({ status: 200, body: undefined })
    expect(serve(READER_FRAME_PATH, 'HEAD')).toMatchObject({ status: 200, body: undefined })
  })

  it('otherPathUnderTheDir_404_NeverTheSpa', () => {
    expect(serve('/reader/page.0000000000000000.js')).toMatchObject({ handled: true, status: 404 })
    expect(serve('/reader/')).toMatchObject({ handled: true, status: 404 })
  })

  it('outsideTheDir_NotHandled_AndOtherMethods405', () => {
    expect(serve('/en/library').handled).toBe(false)
    expect(serve('/reader-other/frame.html').handled).toBe(false)
    expect(serve(READER_FRAME_PATH, 'POST')).toMatchObject({ handled: true, status: 405 })
  })
})

describe('readerDistFiles (frame.mjs): vite preview serves the build', () => {
  it('servedFromABuild_TheBuiltBytes_ShellFilledPerResponse', () => {
    const dist = mkdtempSync(join(tmpdir(), 'ts-frame-dist-'))
    mkdirSync(join(dist, 'reader'))
    writeFileSync(join(dist, 'reader/frame.html'), shell.replace('<body>', '<body><!--built-->'))
    writeFileSync(join(dist, `reader/page.${'a'.repeat(16)}.js`), 'built script')
    const files = readerDistFiles(dist)
    expect(files.scriptPath).toBe(`/reader/page.${'a'.repeat(16)}.js`)
    const req = (url: string) => {
      const out: { status?: number; body?: unknown } = {}
      const res = { writeHead(status: number) { out.status = status; return res }, end(b?: unknown) { out.body = b } }
      serveReaderFrame({ url, method: 'GET' }, res, files)
      return out
    }
    const page = req(READER_FRAME_PATH)
    expect(String(page.body)).toContain('<!--built-->')
    expect(String(page.body)).toMatch(/script-src 'nonce-[0-9a-f]{32}'/)
    expect(String(req(files.scriptPath).body)).toBe('built script')
    expect(req(scriptPath).status).toBe(404) // the source's name, not the build's
    rmSync(dist, { recursive: true, force: true })
  })
})

describe('the host shim (frame.mjs)', () => {
  /** The shell's inline shim, run against a fake frame window: what reaches `__fol` for each parent message. */
  function runShim() {
    const code = shell.match(/<body><script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]
    const parent = {}
    const fol: Record<string, unknown[]> = {}
    const window = { __fol: { describe: (...a: unknown[]) => { fol.describe = a } } }
    let onMessage: (e: unknown) => void = () => {}
    const URL = { createObjectURL: (b: Blob) => `blob:${b.size}`, revokeObjectURL: () => {} }
    new Function('window', 'parent', 'self', 'addEventListener', 'URL', code)(
      window, parent, { origin: 'https://app' }, (_: string, f: typeof onMessage) => { onMessage = f }, URL)
    const send = (call: string, args: unknown[], origin = 'https://app') => onMessage({ source: parent, origin, data: { call, args } })
    return { fol, send }
  }

  it('describeBytes_TheParentsFile_ReachesDescribeAsABlobUrl', () => {
    const { fol, send } = runShim()
    const file = new Blob(['epub bytes'])
    send('describeBytes', [file, 'req-1'], 'https://other')
    send('describeBytes', ['not a blob', 'req-1'])
    expect(fol.describe).toBeUndefined()
    send('describeBytes', [file, 'req-1'])
    expect(fol.describe).toEqual(['req-1', `blob:${file.size}`])
  })
})
