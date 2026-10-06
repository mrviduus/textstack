import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { ReaderNav } from '../ReaderNav'

describe('ReaderNav', () => {
  afterEach(() => cleanup())

  it('renders chapter title + counter', () => {
    const { getByText } = render(
      <ReaderNav
        chapterTitle="Chapter One"
        chapterNumber={1}
        totalChapters={10}
        chapterProgress={0.5}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    )
    expect(getByText('Chapter One')).toBeTruthy()
    expect(getByText('1 / 10')).toBeTruthy()
  })

  it('shows 1 / N for the first chapter (positional index+1, not 0-based catalog number)', () => {
    const { getByText } = render(
      <ReaderNav
        chapterTitle="First"
        chapterNumber={1}
        totalChapters={29}
        chapterProgress={0}
        onPrev={null}
        onNext={() => {}}
      />,
    )
    expect(getByText('1 / 29')).toBeTruthy()
  })

  it('omits counter when totalChapters is null', () => {
    const { container } = render(
      <ReaderNav
        chapterTitle="Only"
        chapterNumber={null}
        totalChapters={null}
        chapterProgress={0}
        onPrev={null}
        onNext={null}
      />,
    )
    expect(container.querySelector('.reader-nav__counter')).toBeNull()
  })

  it('fires onPrev / onNext on button click', () => {
    const onPrev = vi.fn()
    const onNext = vi.fn()
    const { container } = render(
      <ReaderNav
        chapterTitle="x"
        chapterNumber={1}
        totalChapters={2}
        chapterProgress={0}
        onPrev={onPrev}
        onNext={onNext}
      />,
    )
    fireEvent.click(container.querySelector('.reader-nav__btn--prev')!)
    fireEvent.click(container.querySelector('.reader-nav__btn--next')!)
    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('last chapter: the next button finishes the book (L2)', () => {
    const onFinish = vi.fn()
    const { container } = render(
      <ReaderNav
        chapterTitle="x"
        chapterNumber={2}
        totalChapters={2}
        chapterProgress={1}
        onPrev={null}
        onNext={null}
        onFinish={onFinish}
        finishLabel="Finish book"
      />,
    )
    const next = container.querySelector('.reader-nav__btn--next') as HTMLButtonElement
    expect(next.disabled).toBe(false)
    expect(next.getAttribute('aria-label')).toBe('Finish book')
    fireEvent.click(next)
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it('disables buttons when handler is null', () => {
    const { container } = render(
      <ReaderNav
        chapterTitle="x"
        chapterNumber={1}
        totalChapters={2}
        chapterProgress={0}
        onPrev={null}
        onNext={null}
      />,
    )
    const prev = container.querySelector<HTMLButtonElement>('.reader-nav__btn--prev')!
    const next = container.querySelector<HTMLButtonElement>('.reader-nav__btn--next')!
    expect(prev.disabled).toBe(true)
    expect(next.disabled).toBe(true)
  })

  it('clamps progress width into [0, 100]', () => {
    const { container, rerender } = render(
      <ReaderNav
        chapterTitle="x"
        chapterNumber={1}
        totalChapters={2}
        chapterProgress={1.5}
        onPrev={null}
        onNext={null}
      />,
    )
    let bar = container.querySelector<HTMLDivElement>('.reader-nav__progress-bar')!
    expect(bar.style.width).toBe('100%')

    rerender(
      <ReaderNav
        chapterTitle="x"
        chapterNumber={1}
        totalChapters={2}
        chapterProgress={-0.2}
        onPrev={null}
        onNext={null}
      />,
    )
    bar = container.querySelector<HTMLDivElement>('.reader-nav__progress-bar')!
    expect(bar.style.width).toBe('0%')
  })
})
