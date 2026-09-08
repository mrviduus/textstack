import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('../../../hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { DiscussWithAssistant } from '../DiscussWithAssistant'

afterEach(() => cleanup())

const hrefOf = (name: string) =>
  (screen.getByText(name).closest('a') as HTMLAnchorElement).href

describe('DiscussWithAssistant', () => {
  it('links to a NEW conversation on each service', () => {
    render(<DiscussWithAssistant title="Dracula" />)
    expect(hrefOf('library.discuss.claude')).toContain('https://claude.ai/new?q=')
    expect(hrefOf('library.discuss.chatgpt')).toContain('https://chatgpt.com/?q=')
  })

  it('opens third-party origins without handing them this window', () => {
    // These are other people's sites. `noopener` is what stops the opened page
    // reaching back through window.opener.
    render(<DiscussWithAssistant title="Dracula" />)
    for (const key of ['library.discuss.claude', 'library.discuss.chatgpt']) {
      const a = screen.getByText(key).closest('a') as HTMLAnchorElement
      expect(a.target).toBe('_blank')
      expect(a.rel).toContain('noopener')
      expect(a.rel).toContain('noreferrer')
    }
  })

  it('names an upload by bookId and a catalog book by editionId, never both', () => {
    const { unmount } = render(<DiscussWithAssistant title="D" bookId="b-1" />)
    expect(decodeURIComponent(hrefOf('library.discuss.claude'))).toContain('bookId b-1')
    expect(decodeURIComponent(hrefOf('library.discuss.claude'))).not.toContain('editionId')
    unmount()

    render(<DiscussWithAssistant title="D" editionId="e-1" />)
    expect(decodeURIComponent(hrefOf('library.discuss.claude'))).toContain('editionId e-1')
    expect(decodeURIComponent(hrefOf('library.discuss.claude'))).not.toContain('bookId')
  })

  it('reads progress as a fraction, not as a percentage', () => {
    // The defect this field was renamed after: taking 0..1 as "0-100" made
    // Math.round(0.42) === 0, so a reader 42% in opened a chat saying "about 0% in".
    render(<DiscussWithAssistant title="D" progressFraction={0.424} />)
    expect(decodeURIComponent(hrefOf('library.discuss.claude'))).toContain('42%')
  })

  it('keeps the whole URL inside the safe length even for an absurd title', () => {
    // A brief only has to survive being a URL. ~2000 characters is the floor
    // across browsers, redirects and server logs, and encoding roughly doubles
    // punctuation — so the cap lives in the builder, and this is the guard on it.
    render(<DiscussWithAssistant title={'T'.repeat(5000)} bookId="b-1" />)
    expect(hrefOf('library.discuss.claude').length).toBeLessThanOrEqual(2000)
  })
})
