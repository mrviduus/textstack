import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../api/oauth', () => ({ listOAuthGrants: () => Promise.resolve([]) }))
vi.mock('../../../context/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', getLocalizedPath: (p: string) => `/en${p}` }),
}))

import { ChapterReviewAction } from '../ChapterReviewAction'

const book = { title: 'DDIA', userBookId: 'b1' }
const renderRow = (chapter: { slug: string; title: string; wordCount?: number | null }, reviewed = false) =>
  render(<MemoryRouter><ChapterReviewAction book={book} chapter={chapter} reviewed={reviewed} /></MemoryRouter>)

afterEach(cleanup)

describe('ChapterReviewAction', () => {
  it('no Discuss button on front/back matter or a thin chapter', () => {
    renderRow({ slug: 'idx', title: 'Index', wordCount: 9000 })
    renderRow({ slug: 'short', title: 'Preface', wordCount: 300 })
    expect(screen.queryByRole('button', { name: /Discuss/ })).toBeNull()
  })

  it('a real chapter keeps it', () => {
    renderRow({ slug: 'c1', title: '1. Reliable Applications', wordCount: 9000 })
    expect(screen.getByRole('button', { name: /Discuss/ })).toBeInTheDocument()
  })

  it('a reviewed service section still links to its review', () => {
    renderRow({ slug: 'idx', title: 'Index', wordCount: 100 }, true)
    expect(screen.getByRole('link')).toHaveAttribute('href', '/en/library/my/b1/review/idx')
  })
})
