import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ReaderTopBar } from '../ReaderTopBar'

function renderBar(extra?: Partial<React.ComponentProps<typeof ReaderTopBar>>) {
  return render(
    <MemoryRouter>
      <ReaderTopBar
        visible
        title="Book"
        chapterTitle="Chapter 1"
        progress={0.5}
        isBookmarked={false}
        backUrl="/back"
        onSearchClick={() => {}}
        onTocClick={() => {}}
        onSettingsClick={() => {}}
        onBookmarkClick={() => {}}
        {...extra}
      />
    </MemoryRouter>,
  )
}

describe('ReaderTopBar — Original-layout toggle removed (ADR-012)', () => {
  it('renders exactly the 4 positional buttons (search, bookmark, toc, settings) with no toggle', () => {
    const { container } = renderBar()
    const btns = container.querySelectorAll('.reader-top-bar__btn')
    expect(btns.length).toBe(4)
    // No toggle button remains — none should be aria-pressed (toggle used it).
    expect(container.querySelector('[aria-pressed]')).toBeNull()
  })

})

describe('ReaderTopBar — Original-layout PDF adaptations', () => {
  it('hides the search button when showSearch is false (no page-aware search yet)', () => {
    const { container } = renderBar({ showSearch: false })
    const titles = Array.from(container.querySelectorAll('.reader-top-bar__btn')).map((b) =>
      b.getAttribute('title'),
    )
    expect(titles).not.toContain('Search in chapter')
    // bookmark / toc / settings remain
    expect(container.querySelectorAll('.reader-top-bar__btn').length).toBe(3)
  })

  it('shows the % by default but hides it when showProgress is false (Original PDF)', () => {
    // Default: word-based % renders.
    const shown = renderBar()
    expect(shown.container.querySelector('.reader-top-bar__progress')?.textContent).toBe('50%')
    // Original PDF (time-only session → 0%): hidden; the footer page indicator is the real progress.
    const hidden = renderBar({ showProgress: false })
    expect(hidden.container.querySelector('.reader-top-bar__progress')).toBeNull()
  })

  it('stays visible (translateY(0)) when visible is pinned true in Original', () => {
    const { container } = renderBar({ visible: true })
    const header = container.querySelector('.reader-top-bar') as HTMLElement
    expect(header.style.transform).toBe('translateY(0)')
    expect(header.style.opacity).toBe('1')
  })

  it('bookmark toggle click fires onBookmarkClick (page toggle in Original)', () => {
    const onBookmarkClick = vi.fn()
    const { container } = renderBar({ showSearch: false, onBookmarkClick })
    const bookmarkBtn = Array.from(container.querySelectorAll('.reader-top-bar__btn')).find(
      (b) => b.getAttribute('title')?.includes('bookmark'),
    ) as HTMLElement
    bookmarkBtn.click()
    expect(onBookmarkClick).toHaveBeenCalledTimes(1)
  })
})
